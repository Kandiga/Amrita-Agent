import { type UnsealedEvent, newId } from '@amrita/protocol';
import { z } from 'zod';
import { runDoctor } from './doctor.ts';
import type { AmritaKernel } from './kernel.ts';
import { ensureSystemConversation } from './system.ts';

/**
 * The minimal typed scheduler (ADR-0036). Job kinds are code-registered; job
 * CONFIG is persisted in settings under `scheduler.jobs` (non-secret,
 * zod-parsed). The one shipped kind — `system-health` — follows the Hermes
 * watchdog convention: silent on success, a `message.system` into the system
 * conversation only on doctor FAIL (warns are setup states, not incidents).
 *
 * Two-signal heartbeat (Hermes lesson): `lastTickAt` says the ticker is alive;
 * `lastSuccessAt` moves only when a tick completed all due jobs cleanly — so
 * "alive but failing every tick" is visible, not hidden.
 */

export const SCHEDULER_JOBS_SETTING = 'scheduler.jobs';
const MIN_INTERVAL_MINUTES = 5;

export const schedulerJobSchema = z
  .object({
    id: z.string().min(1).max(60),
    kind: z.literal('system-health'),
    title: z.string().min(1).max(120),
    intervalMinutes: z
      .number()
      .int()
      .min(MIN_INTERVAL_MINUTES)
      .max(24 * 60),
    enabled: z.boolean(),
  })
  .strict();
export type SchedulerJob = z.infer<typeof schedulerJobSchema>;

export const schedulerJobsSchema = z.array(schedulerJobSchema).max(20);

export interface SchedulerJobRuntime extends SchedulerJob {
  lastRunAt: string | null;
  lastOutcome: 'ok' | 'problem' | 'error' | null;
}

export interface SchedulerStatus {
  running: boolean;
  lastTickAt: string | null;
  lastSuccessAt: string | null;
  jobs: SchedulerJobRuntime[];
}

export const DEFAULT_HEALTH_JOB: SchedulerJob = {
  id: 'system-health',
  kind: 'system-health',
  title: 'System health watchdog (silent on success)',
  intervalMinutes: 60,
  enabled: true,
};

export interface SchedulerOptions {
  /** Tick cadence in ms (default 60s). Tests inject a manual tick instead. */
  tickMs?: number;
  /** Clock injection for tests. */
  now?: () => Date;
}

export class Scheduler {
  private readonly kernel: AmritaKernel;
  private readonly now: () => Date;
  private readonly tickMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTickAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private readonly runtime = new Map<
    string,
    { lastRunAt: string | null; lastOutcome: 'ok' | 'problem' | 'error' | null }
  >();

  constructor(kernel: AmritaKernel, opts: SchedulerOptions = {}) {
    this.kernel = kernel;
    this.now = opts.now ?? (() => new Date());
    this.tickMs = opts.tickMs ?? 60_000;
  }

  /** The persisted job list (settings-backed); a missing/invalid value = default. */
  jobs(): SchedulerJob[] {
    const raw = this.kernel.getSetting(SCHEDULER_JOBS_SETTING);
    const parsed = schedulerJobsSchema.safeParse(raw);
    return parsed.success ? parsed.data : [DEFAULT_HEALTH_JOB];
  }

  status(): SchedulerStatus {
    return {
      running: this.timer !== null,
      lastTickAt: this.lastTickAt,
      lastSuccessAt: this.lastSuccessAt,
      jobs: this.jobs().map((j) => ({
        ...j,
        lastRunAt: this.runtime.get(j.id)?.lastRunAt ?? null,
        lastOutcome: this.runtime.get(j.id)?.lastOutcome ?? null,
      })),
    };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.tickMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One scheduler pass — public so tests (and `amritad`) can drive it directly. */
  async tick(): Promise<void> {
    const nowIso = this.now().toISOString();
    this.lastTickAt = nowIso; // signal 1: alive
    let clean = true;
    for (const job of this.jobs()) {
      if (!job.enabled) continue;
      const rt = this.runtime.get(job.id);
      if (rt?.lastRunAt) {
        const dueAt = new Date(rt.lastRunAt).getTime() + job.intervalMinutes * 60_000;
        if (this.now().getTime() < dueAt) continue;
      }
      try {
        const outcome = await this.runJob(job);
        this.runtime.set(job.id, { lastRunAt: nowIso, lastOutcome: outcome });
      } catch {
        clean = false;
        this.runtime.set(job.id, { lastRunAt: nowIso, lastOutcome: 'error' });
      }
    }
    if (clean) this.lastSuccessAt = nowIso; // signal 2: productive
  }

  private async runJob(job: SchedulerJob): Promise<'ok' | 'problem'> {
    switch (job.kind) {
      case 'system-health': {
        const report = await runDoctor(this.kernel);
        if (report.status !== 'fail') return 'ok'; // silent on success (and on setup warns)
        const failed = report.sections
          .flatMap((s) => s.checks)
          .filter((c) => c.status === 'fail')
          .slice(0, 5)
          .map((c) => `- ${c.label}: ${c.detail ?? 'failed'}${c.fix ? ` (fix: ${c.fix})` : ''}`);
        const ctx = ensureSystemConversation(this.kernel);
        this.kernel.store.appendEvent({
          id: newId(),
          ts: this.now().toISOString(),
          projectId: ctx.projectId,
          conversationId: ctx.conversationId,
          origin: 'system',
          type: 'message.system',
          payload: {
            text: `⚠ system-health watchdog: doctor reports FAIL\n${failed.join('\n')}`,
          },
        } as UnsealedEvent);
        return 'problem';
      }
    }
  }
}
