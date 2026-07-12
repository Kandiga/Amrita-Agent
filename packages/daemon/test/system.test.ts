import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AmritaKernel } from '../src/kernel.ts';
import { Scheduler } from '../src/scheduler.ts';
import {
  ensureSystemConversation,
  systemAudit,
  systemHealth,
  systemManage,
  systemPlan,
} from '../src/system.ts';

/** R3 (ADR-0036): Global Amrita — system project, System Brain verbs, scheduler. */

let kernel: AmritaKernel;

beforeEach(() => {
  kernel = AmritaKernel.open({
    dbPath: ':memory:',
    codingRuntimeProber: async () => ({ kind: 'spawn_error' }),
    fetchImpl: async () => new Response('{}', { status: 500 }),
  });
});
afterEach(() => {
  kernel.close();
});

describe('system brain verbs (ADR-0036)', () => {
  it('the system project + global conversation are ensured once, never duplicated', () => {
    const a = ensureSystemConversation(kernel);
    const b = ensureSystemConversation(kernel);
    expect(a).toEqual(b);
    expect(kernel.listProjects().filter((p) => p.slug === 'system')).toHaveLength(1);
  });

  it('system.audit sweeps all projects and can record findings into the system brain', () => {
    const p1 = kernel.ensureProject({ slug: 'alpha', name: 'Alpha' });
    const c1 = kernel.createConversation({ projectId: p1.id });
    kernel.openQuestion({ projectId: p1.id, conversationId: c1.id, text: 'which auth?' });
    kernel.openRisk({
      projectId: p1.id,
      conversationId: c1.id,
      text: 'data loss',
      severity: 'high',
    });

    const dry = systemAudit(kernel);
    const kinds = dry.findings.filter((f) => f.slug === 'alpha').map((f) => f.kind);
    expect(kinds).toContain('missing-brief');
    expect(kinds).toContain('unresolved-questions');
    expect(kinds).toContain('open-risks');
    expect(dry.recorded).toBe(0);

    const recorded = systemAudit(kernel, { record: true });
    expect(recorded.recorded).toBeGreaterThan(0);
    // findings land in the SYSTEM project's brain with provenance
    const sys = ensureSystemConversation(kernel);
    const brain = kernel.getProjectBrain(sys.projectId);
    const auditRecords = brain.records.filter((r) => r.provenance.sourceId === 'system:audit');
    expect(auditRecords.length).toBe(recorded.recorded);
    expect(auditRecords[0]?.title).toContain('[audit]');
  });

  it('system.plan drafts into the TARGET project brain with system provenance; never executes', () => {
    const p = kernel.ensureProject({ slug: 'beta', name: 'Beta' });
    const r = systemPlan(kernel, { projectId: p.id, title: 'Adopt wire contracts', body: 'do it' });
    expect(r.entryId).toBeTypeOf('string');
    const brain = kernel.getProjectBrain(p.id);
    const rec = brain.records.find((x) => x.title.includes('[plan] Adopt wire contracts'));
    expect(rec?.provenance.sourceId).toBe('system:plan');
    expect(kernel.listLanes({ projectId: p.id })).toHaveLength(0); // plan ≠ execution
  });

  it('system.manage delegates as a lane through the standard gates', async () => {
    const p = kernel.ensureProject({ slug: 'gamma', name: 'Gamma' });
    const r = await systemManage(kernel, { projectId: p.id, goal: 'tidy repo', dryRun: true });
    expect(r.status).toBe('spawned');
    expect(r.dryRun).toBe(true);
    const lanes = kernel.listLanes({ projectId: p.id });
    expect(lanes).toHaveLength(1);
  });

  it('system.health aggregates doctor + project brain counts + scheduler heartbeat (null when off)', async () => {
    kernel.ensureProject({ slug: 'delta', name: 'Delta' });
    const h = await systemHealth(kernel);
    expect(h.doctor.sections.length).toBeGreaterThan(5);
    expect(h.scheduler).toBeNull(); // honest: no scheduler attached
    expect(h.projects.some((p) => p.slug === 'delta')).toBe(true);
    expect(h.projects.some((p) => p.slug === 'system')).toBe(false);
  });
});

describe('scheduler (ADR-0036)', () => {
  it('ticks with a two-signal heartbeat and stays silent when the doctor does not FAIL', async () => {
    let t = new Date('2026-07-12T10:00:00.000Z').getTime();
    const s = new Scheduler(kernel, { now: () => new Date(t) });
    kernel.attachScheduler(s);

    await s.tick();
    const st1 = kernel.getSchedulerStatus();
    expect(st1?.lastTickAt).toBe('2026-07-12T10:00:00.000Z');
    expect(st1?.lastSuccessAt).toBe('2026-07-12T10:00:00.000Z');
    expect(st1?.jobs[0]?.lastOutcome).toBe('ok'); // fresh kernel: warns, never fail → silent

    // silent on success: nothing posted into the system conversation
    const sys = ensureSystemConversation(kernel);
    expect(kernel.store.listMessages(sys.conversationId)).toHaveLength(0);

    // interval respected: a tick 1 minute later does not re-run the hourly job
    t += 60_000;
    await s.tick();
    expect(kernel.getSchedulerStatus()?.jobs[0]?.lastRunAt).toBe('2026-07-12T10:00:00.000Z');
  });

  it('start/stop toggles running; status reports the typed default job', () => {
    const s = new Scheduler(kernel, { tickMs: 3_600_000 });
    expect(s.status().running).toBe(false);
    s.start();
    expect(s.status().running).toBe(true);
    void s.stop();
    expect(s.status().running).toBe(false);
    expect(s.status().jobs[0]).toMatchObject({ id: 'system-health', enabled: true });
  });
});
