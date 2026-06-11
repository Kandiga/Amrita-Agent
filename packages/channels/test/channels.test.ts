import { AmritaKernel } from '@amrita/daemon';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TelegramChannel, type TelegramSender, WebChannel, chunkText } from '../src/index.ts';

let kernel: AmritaKernel;

class FakeSender implements TelegramSender {
  readonly sent: { chatId: string; text: string }[] = [];
  sendMessage(chatId: string, text: string): void {
    this.sent.push({ chatId, text });
  }
}
let sender: FakeSender;

beforeEach(() => {
  kernel = AmritaKernel.open({ dbPath: ':memory:' });
  sender = new FakeSender();
});
afterEach(() => {
  kernel.close();
});

function project(): string {
  return kernel.ensureProject({ slug: 'crm', name: 'CRM' }).id;
}
function linkedConversation(userAllowed: number): { conv: string; code: string } {
  const projectId = project();
  const conv = kernel.createConversation({ projectId }).id;
  const { code } = kernel.createPairing({ channel: 'telegram', projectId, conversationId: conv });
  return { conv, code };
}

describe('chunkText', () => {
  it('splits into ordered ≤maxLen chunks that rejoin to the input', () => {
    expect(chunkText('hello', 10)).toEqual(['hello']);
    const chunks = chunkText('abcdefghij', 4);
    expect(chunks).toEqual(['abcd', 'efgh', 'ij']);
    expect(chunks.join('')).toBe('abcdefghij');
  });
});

describe('TelegramChannel (owner gate)', () => {
  it('denies non-allowlisted users for messages AND callbacks (deny-by-default)', async () => {
    const ch = new TelegramChannel(kernel, sender, { allowedUserIds: [] }); // nobody
    const m = await ch.handleUpdate({ kind: 'message', userId: '999', chatId: 'c', text: 'hi' });
    const cb = await ch.handleUpdate({
      kind: 'callback',
      userId: '999',
      chatId: 'c',
      text: 'data',
    });
    expect(m.outcome).toBe('denied');
    expect(cb.outcome).toBe('denied');
    expect(sender.sent).toHaveLength(0); // nothing sent to a denied user
    expect(ch.droppedUserIds).toEqual(['999', '999']);
  });

  it('prompts an allowed-but-unpaired owner to pair', async () => {
    const ch = new TelegramChannel(kernel, sender, { allowedUserIds: [123] });
    const r = await ch.handleUpdate({ kind: 'message', userId: '123', chatId: 'c', text: 'hello' });
    expect(r.outcome).toBe('unpaired');
    expect(sender.sent[0]?.text).toContain('/pair');
  });

  it('pairs via /pair CODE then runs a chat turn for the owner', async () => {
    const { conv, code } = linkedConversation(123);
    const ch = new TelegramChannel(kernel, sender, { allowedUserIds: [123] });

    const pair = await ch.handleUpdate({
      kind: 'message',
      userId: '123',
      chatId: 'c',
      text: `/pair ${code}`,
    });
    expect(pair.outcome).toBe('paired');

    const chat = await ch.handleUpdate({
      kind: 'message',
      userId: '123',
      chatId: 'c',
      text: 'fix the export',
    });
    expect(chat.outcome).toBe('replied');
    expect(chat.conversationId).toBe(conv);
    expect(chat.replies.join('')).toContain('fix the export'); // mock echoes the user text
    expect(kernel.listEvents(conv).some((e) => e.type === 'message.agent')).toBe(true);
  });

  it('rejects an already-claimed or unknown pairing code safely', async () => {
    const { code } = linkedConversation(1);
    const ch = new TelegramChannel(kernel, sender, { allowedUserIds: [1, 2] });
    await ch.handleUpdate({ kind: 'message', userId: '1', chatId: 'c', text: `/pair ${code}` });
    const second = await ch.handleUpdate({
      kind: 'message',
      userId: '2',
      chatId: 'c',
      text: `/pair ${code}`,
    });
    expect(second.outcome).toBe('error');
    expect(second.error).toContain('already claimed');
    const unknown = await ch.handleUpdate({
      kind: 'message',
      userId: '1',
      chatId: 'c',
      text: '/pair NOPE',
    });
    expect(unknown.error).toContain('unknown pairing code');
  });

  it('chunks long replies in order', async () => {
    const { code } = linkedConversation(7);
    const ch = new TelegramChannel(kernel, sender, { allowedUserIds: [7], chunkSize: 10 });
    await ch.handleUpdate({ kind: 'message', userId: '7', chatId: 'c', text: `/pair ${code}` });
    sender.sent.length = 0; // clear the pairing reply

    const r = await ch.handleUpdate({
      kind: 'message',
      userId: '7',
      chatId: 'c',
      text: 'hello there world',
    });
    expect(r.replies.length).toBeGreaterThan(1);
    expect(r.replies.every((c) => c.length <= 10)).toBe(true);
    expect(sender.sent.map((s) => s.text)).toEqual(r.replies); // sent in order
    expect(r.replies.join('')).toContain('hello there world');
  });

  it('never holds or emits a token/secret', async () => {
    const { code } = linkedConversation(1);
    const ch = new TelegramChannel(kernel, sender, { allowedUserIds: [1] });
    await ch.handleUpdate({ kind: 'message', userId: '1', chatId: 'c', text: `/pair ${code}` });
    const r = await ch.handleUpdate({ kind: 'message', userId: '1', chatId: 'c', text: 'hi' });
    expect(JSON.stringify({ r, sent: sender.sent })).not.toMatch(/sk-|password|bot[0-9]{6}/i);
  });
});

describe('WebChannel', () => {
  it('runs a chat turn and returns the reply', async () => {
    const projectId = project();
    const conv = kernel.createConversation({ projectId }).id;
    const r = await new WebChannel(kernel).handle({ conversationId: conv, text: 'hello web' });
    expect(r.outcome).toBe('replied');
    expect(r.replies[0]).toContain('hello web');
  });

  it('returns a safe error for an unknown conversation', async () => {
    const r = await new WebChannel(kernel).handle({ conversationId: 'NOSUCH', text: 'hi' });
    expect(r.outcome).toBe('error');
    expect(r.error).toContain('no such conversation');
    expect(r.error).not.toMatch(/\bat \//); // no stack
  });
});

describe('telegram operator commands (ADR-0021)', () => {
  async function pairedChannel(): Promise<{
    ch: TelegramChannel;
    projectId: string;
    conv: string;
  }> {
    const projectId = kernel.ensureProject({ slug: 'crm', name: 'CRM' }).id;
    const conv = kernel.createConversation({ projectId }).id;
    const { code } = kernel.createPairing({ channel: 'telegram', projectId, conversationId: conv });
    const ch = new TelegramChannel(kernel, sender, { allowedUserIds: [42] });
    await ch.handleUpdate({ kind: 'message', userId: '42', chatId: 'c', text: `/pair ${code}` });
    return { ch, projectId, conv };
  }

  it('/status reports honest project numbers; /help lists commands', async () => {
    const { ch, projectId, conv } = await pairedChannel();
    kernel.upsertBrief({ projectId, conversationId: conv, goal: 'ship operator mode' });
    kernel.openQuestion({ projectId, conversationId: conv, text: 'which polling interval?' });
    kernel.createTask({ projectId, conversationId: conv, title: 'wire runner' });

    const r = await ch.handleUpdate({
      kind: 'message',
      userId: '42',
      chatId: 'c',
      text: '/status',
    });
    expect(r.outcome).toBe('command');
    const reply = r.replies.join('\n');
    expect(reply).toContain('goal: ship operator mode');
    expect(reply).toContain('tasks: 1 open / 1 total');
    expect(reply).toContain('questions: 1 open');
    expect(reply).toContain('approvals: 0 pending');

    const help = await ch.handleUpdate({
      kind: 'message',
      userId: '42',
      chatId: 'c',
      text: '/help',
    });
    expect(help.replies.join('')).toContain('/approve');
  });

  it('/approvals lists pending; /approve resolves it (prefix-matched, project-scoped)', async () => {
    const { ch, projectId, conv } = await pairedChannel();
    // a pending approval raised by the kernel (e.g. a real lane gate)
    const decision = kernel.requestApproval(
      { projectId, conversationId: conv },
      'lane.run-real',
      'deploy the fix',
    );
    const list = await ch.handleUpdate({
      kind: 'message',
      userId: '42',
      chatId: 'c',
      text: '/approvals',
    });
    expect(list.replies.join('\n')).toContain('lane.run-real');
    expect(list.replies.join('\n')).toContain('deploy the fix');

    const id = kernel.listPendingApprovals()[0]?.approvalId ?? '';
    const approve = await ch.handleUpdate({
      kind: 'message',
      userId: '42',
      chatId: 'c',
      text: `/approve ${id.slice(0, 8).toLowerCase()}`, // prefix, case-insensitive
    });
    expect(approve.replies.join('')).toContain('approved');
    await expect(decision).resolves.toBe('allow');
    expect(kernel.listPendingApprovals()).toEqual([]);
  });

  it('/deny refuses; approvals from OTHER projects are invisible', async () => {
    const { ch, projectId, conv } = await pairedChannel();
    const otherProject = kernel.ensureProject({ slug: 'other', name: 'Other' }).id;
    const otherConv = kernel.createConversation({ projectId: otherProject }).id;
    const foreign = kernel.requestApproval(
      { projectId: otherProject, conversationId: otherConv },
      'lane.run-real',
      'foreign work',
    );
    const mine = kernel.requestApproval(
      { projectId, conversationId: conv },
      'lane.run-real',
      'my work',
    );

    const list = await ch.handleUpdate({
      kind: 'message',
      userId: '42',
      chatId: 'c',
      text: '/approvals',
    });
    expect(list.replies.join('\n')).toContain('my work');
    expect(list.replies.join('\n')).not.toContain('foreign work'); // project isolation

    const myId =
      kernel.listPendingApprovals().find((a) => a.projectId === projectId)?.approvalId ?? '';
    const deny = await ch.handleUpdate({
      kind: 'message',
      userId: '42',
      chatId: 'c',
      text: `/deny ${myId.slice(0, 10)}`,
    });
    expect(deny.replies.join('')).toContain('denied');
    await expect(mine).resolves.toBe('deny');
    // the foreign approval is untouched
    expect(kernel.listPendingApprovals().map((a) => a.projectId)).toEqual([otherProject]);
    kernel.resolveApproval(kernel.listPendingApprovals()[0]?.approvalId ?? '', 'deny');
    await foreign;
  });

  it('commands stay owner-gated and /lanes//stop answer honestly when empty', async () => {
    const { ch } = await pairedChannel();
    const stranger = await ch.handleUpdate({
      kind: 'message',
      userId: '999',
      chatId: 'x',
      text: '/status',
    });
    expect(stranger.outcome).toBe('denied');

    const lanes = await ch.handleUpdate({
      kind: 'message',
      userId: '42',
      chatId: 'c',
      text: '/lanes',
    });
    expect(lanes.replies.join('')).toContain('no lanes yet');
    const stop = await ch.handleUpdate({
      kind: 'message',
      userId: '42',
      chatId: 'c',
      text: '/stop zzz',
    });
    expect(stop.replies.join('')).toContain('no active lane');
    const unknown = await ch.handleUpdate({
      kind: 'message',
      userId: '42',
      chatId: 'c',
      text: '/bogus',
    });
    expect(unknown.replies.join('')).toContain('/help');
  });
});
