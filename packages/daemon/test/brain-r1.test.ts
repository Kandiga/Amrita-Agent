import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { probeGitContext, summarizeFiles } from '../src/context.ts';
import { AmritaKernel, buildCompressionDigest } from '../src/kernel.ts';
import { dispatch, isErrorResponse } from '../src/rpc.ts';
import type { CommandProber } from '../src/runtimes.ts';
import { SYSTEM_SKILLS, loadSkillStatuses } from '../src/skills.ts';

/** R1 behaviors: compression-as-lineage (ADR-0033), context probes (ADR-0034),
 * skill registry (ADR-0035). */

let kernel: AmritaKernel;
let tmp: string;

beforeEach(() => {
  kernel = AmritaKernel.open({ dbPath: ':memory:' });
  tmp = mkdtempSync(join(tmpdir(), 'amrita-r1-'));
});
afterEach(() => {
  kernel.close();
  rmSync(tmp, { recursive: true, force: true });
});

function seedConversation(text = 'hello'): { projectId: string; conversationId: string } {
  const p = kernel.ensureProject({ slug: 'r1', name: 'R1' });
  const c = kernel.createConversation({ projectId: p.id });
  kernel.recordUserMessage({ projectId: p.id, conversationId: c.id, text });
  kernel.store.recordAgentMessage({ projectId: p.id, conversationId: c.id, text: `re: ${text}` });
  return { projectId: p.id, conversationId: c.id };
}

describe('conversation compression (ADR-0033)', () => {
  it('creates a lineage child with a digest, records + archives the parent, keeps the log replayable', () => {
    const { conversationId } = seedConversation('the PDF export breaks on RTL');
    const r = kernel.compressConversation(conversationId);

    // child: lineage + digest system message
    const child = kernel.getConversation(r.childConversationId);
    expect(child?.parentId).toBe(conversationId);
    const childMessages = kernel.store.listMessages(r.childConversationId);
    expect(childMessages[0]?.role).toBe('system');
    expect(childMessages[0]?.text).toContain('Compressed continuation');
    expect(childMessages[0]?.text).toContain('PDF export');

    // parent: compressed event + archived (projection sets archived_at)
    const parentEvents = kernel.listEvents(conversationId);
    const types = parentEvents.map((e) => e.type);
    expect(types).toContain('conversation.compressed');
    expect(types).toContain('conversation.archived');
    expect(kernel.getConversation(conversationId)?.archivedAt).toBeTypeOf('string');
    expect(r.messageCount).toBe(2);

    // amendment: the digest lands in the project memory layer with session provenance
    const memories = kernel.searchMemory('Compressed continuation', { projectId: 'ignored' });
    const hit = kernel.store
      .listMemoryEntries(kernel.getConversation(conversationId)?.projectId ?? '')
      .find((m) => (m.source ?? '').startsWith('session:compress:'));
    expect(hit?.content).toContain('Compressed continuation');
    // and the Brain shows it as a chat-provenance record
    const brain = kernel.getProjectBrain(kernel.getConversation(conversationId)?.projectId ?? '');
    expect(
      brain.records.some((rec) => rec.provenance.sourceId === 'chat' && rec.body.includes('PDF')),
    ).toBe(true);
    void memories;
  });

  it('refuses an empty conversation and a double compression, as `conflict` over RPC', async () => {
    const p = kernel.ensureProject({ slug: 'r1b', name: 'R1b' });
    const empty = kernel.createConversation({ projectId: p.id });
    const r1 = await dispatch(kernel, {
      id: 1,
      method: 'conversation.compress',
      params: { conversationId: empty.id },
    });
    expect(isErrorResponse(r1) && r1.error.code).toBe('conflict');

    const { conversationId } = seedConversation();
    kernel.compressConversation(conversationId);
    const r2 = await dispatch(kernel, {
      id: 2,
      method: 'conversation.compress',
      params: { conversationId },
    });
    expect(isErrorResponse(r2) && r2.error.code).toBe('conflict');
  });

  it('digest is deterministic and bounded', () => {
    const msgs = Array.from({ length: 12 }, (_, i) => ({
      role: i % 2 ? 'agent' : 'user',
      text: `message number ${i} ${'x'.repeat(300)}`,
      createdAt: `2026-07-0${(i % 9) + 1}T10:00:00.000Z`,
    }));
    const a = buildCompressionDigest('My chat', msgs);
    const b = buildCompressionDigest('My chat', msgs);
    expect(a).toBe(b);
    expect(a.length).toBeLessThanOrEqual(4000);
    expect(a).toContain('12 messages');
    expect(a).toContain('…'); // long messages truncated
  });
});

describe('project context probes (ADR-0034)', () => {
  it('is honest when no root is configured or the root is missing', async () => {
    const p = kernel.ensureProject({ slug: 'noroot', name: 'NoRoot' });
    expect(await kernel.getProjectContext(p.id)).toMatchObject({
      configured: false,
      root: null,
      git: null,
      files: null,
    });
    const p2 = kernel.ensureProject({ slug: 'ghost', name: 'Ghost', root: '/no/such/dir/xyz' });
    expect(await kernel.getProjectContext(p2.id)).toMatchObject({
      configured: true,
      exists: false,
      git: null,
    });
  });

  it('summarizes files with caps and skips node_modules/dot-dirs', () => {
    writeFileSync(join(tmp, 'a.txt'), 'a');
    mkdirSync(join(tmp, 'src'));
    writeFileSync(join(tmp, 'src', 'b.ts'), 'b');
    writeFileSync(join(tmp, 'src', 'c.ts'), 'c');
    mkdirSync(join(tmp, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(tmp, 'node_modules', 'x', 'skip.js'), 'skip');
    mkdirSync(join(tmp, '.hidden'));
    writeFileSync(join(tmp, '.hidden', 'skip.txt'), 'skip');

    const files = summarizeFiles(tmp);
    expect(files.totalFiles).toBe(3);
    expect(files.topDirs).toEqual([{ name: 'src', files: 2 }]);
    expect(files.truncated).toBe(false);
  });

  it('probes git state through the injected bounded prober', async () => {
    const prober: CommandProber = async (_cmd, args) => {
      if (args.includes('--is-inside-work-tree')) return { kind: 'ok', stdout: 'true\n' };
      if (args.includes('--abbrev-ref')) return { kind: 'ok', stdout: 'v2-main\n' };
      if (args.includes('--porcelain')) return { kind: 'ok', stdout: ' M a.txt\n?? b.txt\n' };
      if (args.includes('--left-right')) return { kind: 'failed', stdout: '' }; // no upstream
      if (args.includes('log')) return { kind: 'ok', stdout: 'abc1234 fix the thing\n' };
      return { kind: 'failed', stdout: '' };
    };
    const git = await probeGitContext(tmp, prober);
    expect(git).toEqual({
      isRepo: true,
      branch: 'v2-main',
      dirtyCount: 2,
      lastCommit: 'abc1234 fix the thing',
    });

    const notRepo: CommandProber = async () => ({ kind: 'failed', stdout: '' });
    expect(await probeGitContext(tmp, notRepo)).toEqual({ isRepo: false });
  });
});

describe('skill registry (ADR-0035)', () => {
  const manifest = (over: Record<string, unknown> = {}) => ({
    name: 'good-skill',
    tier: 'shared',
    version: '1.0.0',
    description: 'a well-formed example skill',
    owner: 'tester',
    permissions: { toolsets: ['harness.capture'] },
    usage: 'run it from the tests; this is long enough documentation.',
    ...over,
  });

  function writeSkill(base: string, dir: string, content: unknown | null): void {
    mkdirSync(join(base, dir), { recursive: true });
    if (content !== null) {
      writeFileSync(
        join(base, dir, 'skill.json'),
        typeof content === 'string' ? content : JSON.stringify(content),
      );
    }
  }

  it('system skills are code-registered, valid, and active', () => {
    const rows = loadSkillStatuses({ homeDir: tmp });
    const system = rows.filter((r) => r.tier === 'system');
    expect(system.map((r) => r.name)).toEqual(SYSTEM_SKILLS.map((m) => m.name));
    expect(system.every((r) => r.state === 'active')).toBe(true);
  });

  it('refuses unregistered, invalid, undocumented, and tier-mismatched skills', () => {
    const shared = join(tmp, 'skills');
    writeSkill(shared, 'good-skill', manifest());
    writeSkill(shared, 'no-manifest', null);
    writeSkill(shared, 'bad-json', '{ not json');
    writeSkill(shared, 'undocumented', manifest({ name: 'undocumented', usage: 'too short' }));

    const projectRoot = join(tmp, 'proj');
    const projSkills = join(projectRoot, '.amrita', 'skills');
    writeSkill(projSkills, 'proj-skill', manifest({ name: 'proj-skill', tier: 'project' }));
    writeSkill(projSkills, 'wrong-tier', manifest({ name: 'wrong-tier', tier: 'shared' }));

    const rows = loadSkillStatuses({ homeDir: tmp, projectRoot });
    const byName = new Map(rows.map((r) => [r.name, r]));
    expect(byName.get('good-skill')?.state).toBe('active');
    expect(byName.get('proj-skill')?.state).toBe('active');
    expect(byName.get('no-manifest')?.state).toBe('unregistered');
    expect(byName.get('bad-json')?.state).toBe('invalid');
    expect(byName.get('undocumented')?.state).toBe('invalid');
    expect(byName.get('undocumented')?.detail).toContain('usage');
    expect(byName.get('wrong-tier')?.state).toBe('invalid');
    expect(byName.get('wrong-tier')?.detail).toContain('tier');

    // the load-bearing rule: nothing refused is ever active
    for (const r of rows) {
      if (['no-manifest', 'bad-json', 'undocumented', 'wrong-tier'].includes(r.name)) {
        expect(r.state).not.toBe('active');
        expect(r.manifest).toBeUndefined();
      }
    }
  });
});
