import { AmritaKernel } from '@amrita/daemon';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WhatsAppChannel, whatsAppConfigStatus } from '../src/whatsapp.ts';

/**
 * ADR-0037: WhatsApp passes the SAME channel-contract suite as Telegram —
 * the shared handler guarantees identical behavior, these tests prove it.
 */

class FakeSender {
  readonly sent: { chatId: string; text: string }[] = [];
  sendMessage(chatId: string, text: string): void {
    this.sent.push({ chatId, text });
  }
}

let kernel: AmritaKernel;
let sender: FakeSender;

beforeEach(() => {
  kernel = AmritaKernel.open({ dbPath: ':memory:' });
  sender = new FakeSender();
});
afterEach(() => {
  kernel.close();
});

function pairedChannel(): { channel: WhatsAppChannel; projectId: string; code: string } {
  const project = kernel.ensureProject({ slug: 'wa', name: 'WA' });
  const conversation = kernel.createConversation({ projectId: project.id });
  const pairing = kernel.createPairing({
    channel: 'whatsapp',
    projectId: project.id,
    conversationId: conversation.id,
  });
  const channel = new WhatsAppChannel(kernel, sender, { allowedUserIds: ['15550001111'] });
  return { channel, projectId: project.id, code: pairing.code };
}

describe('whatsapp channel (ADR-0037)', () => {
  it('deny-by-default: a stranger is dropped without any reply', async () => {
    const channel = new WhatsAppChannel(kernel, sender, { allowedUserIds: [] });
    const r = await channel.handleUpdate({
      kind: 'message',
      userId: '19998887777',
      chatId: 'c1',
      text: 'hi',
    });
    expect(r.outcome).toBe('denied');
    expect(sender.sent).toHaveLength(0);
    expect(channel.droppedUserIds).toEqual(['19998887777']);
  });

  it('pairs an allowed owner and then runs chat turns in the linked conversation', async () => {
    const { channel, code } = pairedChannel();
    const paired = await channel.handleUpdate({
      kind: 'message',
      userId: '15550001111',
      chatId: 'c1',
      text: `/pair ${code}`,
    });
    expect(paired.outcome).toBe('paired');

    const replied = await channel.handleUpdate({
      kind: 'message',
      userId: '15550001111',
      chatId: 'c1',
      text: 'hello from whatsapp',
    });
    expect(replied.outcome).toBe('replied');
    expect(replied.replies.join(' ')).toContain('hello from whatsapp'); // mock echoes
    // the turn is recorded with whatsapp channel provenance
    const events = kernel.listEvents(replied.conversationId ?? '');
    expect(events.some((e) => e.channel === 'whatsapp')).toBe(true);
  });

  it('answers operator commands via the shared kernel interpreter (parity)', async () => {
    const { channel, code, projectId } = pairedChannel();
    await channel.handleUpdate({
      kind: 'message',
      userId: '15550001111',
      chatId: 'c1',
      text: `/pair ${code}`,
    });
    const r = await channel.handleUpdate({
      kind: 'message',
      userId: '15550001111',
      chatId: 'c1',
      text: '/status',
    });
    expect(r.outcome).toBe('command');
    expect(r.replies.join('\n')).toContain('no brief yet');
    // parity: the kernel service gives the same answer directly
    const { runOperatorCommand } = await import('@amrita/daemon');
    expect(r.replies.join('')).toBe(await runOperatorCommand(kernel, '/status', projectId));
  });

  it('unpaired allowed users are told exactly how to pair', async () => {
    const channel = new WhatsAppChannel(kernel, sender, { allowedUserIds: ['15550001111'] });
    const r = await channel.handleUpdate({
      kind: 'message',
      userId: '15550001111',
      chatId: 'c1',
      text: 'hi',
    });
    expect(r.outcome).toBe('unpaired');
    expect(r.replies[0]).toContain('/pair');
  });

  it('config status is presence-only and names the missing env vars', () => {
    const status = whatsAppConfigStatus({});
    expect(status.configured).toBe(false);
    expect(status.missingEnv).toEqual([
      'WHATSAPP_ACCESS_TOKEN',
      'WHATSAPP_PHONE_NUMBER_ID',
      'WHATSAPP_VERIFY_TOKEN',
    ]);
    expect(
      whatsAppConfigStatus({
        WHATSAPP_ACCESS_TOKEN: 'x',
        WHATSAPP_PHONE_NUMBER_ID: 'y',
        WHATSAPP_VERIFY_TOKEN: 'z',
      }).configured,
    ).toBe(true);
  });
});

describe('one brain across channels (R6 fitness function)', () => {
  it('telegram + web turns land in the SAME conversation with per-channel provenance', async () => {
    const { TelegramChannel } = await import('../src/telegram.ts');
    const project = kernel.ensureProject({ slug: 'brain', name: 'Brain' });
    const conversation = kernel.createConversation({ projectId: project.id });
    const pairing = kernel.createPairing({
      channel: 'telegram',
      projectId: project.id,
      conversationId: conversation.id,
    });
    const tg = new TelegramChannel(kernel, sender, { allowedUserIds: [42] });
    await tg.handleUpdate({
      kind: 'message',
      userId: '42',
      chatId: 'c1',
      text: `/pair ${pairing.code}`,
    });
    await tg.handleUpdate({ kind: 'message', userId: '42', chatId: 'c1', text: 'from telegram' });
    await kernel.runChatTurn({ conversationId: conversation.id, text: 'from web', channel: 'web' });

    // ONE conversation holds both exchanges — no per-channel memory, ever.
    const messages = kernel.store.listMessages(conversation.id);
    expect(messages.filter((m) => m.role === 'user').map((m) => m.text)).toEqual([
      'from telegram',
      'from web',
    ]);
    const channels = kernel
      .listEvents(conversation.id)
      .filter((e) => e.type === 'message.user')
      .map((e) => e.channel);
    expect(channels).toEqual(['telegram', 'web']);
  });
});
