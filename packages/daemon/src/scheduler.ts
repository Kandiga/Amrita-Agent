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
/**
 * Where the scheduler remembers when each job last ran (ADR-0045).
 *
 * It used to be an in-memory Map, which meant a daemon restart made EVERY job
 * immediately due. Harmless for a silent health check; not harmless at all for a
 * weekly review, which would fire a fresh packet on every restart.
 */
export const SCHEDULER_STATE_SETTING = 'scheduler.state';
const MIN_INTERVAL_MINUTES = 5;
/** A week. The old ceiling was 24h, which made "weekly" literally inexpressible. */
const MAX_INTERVAL_MINUTES = 7 * 24 * 60;

export const schedulerJobSchema = z
  .object({
    id: z.string().min(1).max(60),
    kind: z.enum(['system-health', 'project-review', 'daily-digest']),
    title: z.string().min(1).max(120),
    intervalMinutes: z.number().int().min(MIN_INTERVAL_MINUTES).max(MAX_INTERVAL_MINUTES),
    enabled: z.boolean(),
    /** `project-review` only: which project. Absent ⇒ every activated project. */
    projectId: z.string().optional(),
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

/** ADR-0045: the weekly review. Proposes; never changes anything. */
export const DEFAULT_REVIEW_JOB: SchedulerJob = {
  id: 'project-review',
  kind: 'project-review',
  title: 'Weekly project review (proposes, never acts)',
  intervalMinutes: 7 * 24 * 60,
  enabled: true,
};

/** HARMONY-2: the daily digest — what runs/waits/fails, pushed to paired chats. */
export const DEFAULT_DIGEST_JOB: SchedulerJob = {
  id: 'daily-digest',
  kind: 'daily-digest',
  title: 'Daily digest to paired chats (silent when quiet)',
  intervalMinutes: 24 * 60,
  enabled: true,
};

/** Persisted run-state, so a restart does not re-fire every job. */
const schedulerStateSchema = z.record(
  z.string(),
  z.object({
    lastRunAt: z.string().nullable(),
    lastOutcome: z.enum(['ok', 'problem', 'error']).nullable(),
  }),
);

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
  private ticking = false;
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
    return parsed.success
      ? parsed.data
      : [DEFAULT_HEALTH_JOB, DEFAULT_REVIEW_JOB, DEFAULT_DIGEST_JOB];
  }

  /**
   * Run-state, read from settings (ADR-0045). The in-memory Map it replaces meant
   * every restart made every job due — which for a weekly review would mean a
   * fresh packet every time the daemon bounced.
   */
  private state(): Record<
    string,
    { lastRunAt: string | null; lastOutcome: 'ok' | 'problem' | 'error' | null }
  > {
    const parsed = schedulerStateSchema.safeParse(this.kernel.getSetting(SCHEDULER_STATE_SETTING));
    return parsed.success ? parsed.data : {};
  }

  private recordRun(jobId: string, outcome: 'ok' | 'problem' | 'error', at: string): void {
    const next = { ...this.state(), [jobId]: { lastRunAt: at, lastOutcome: outcome } };
    this.runtime.set(jobId, { lastRunAt: at, lastOutcome: outcome });
    try {
      this.kernel.putSchedulerState(next);
    } catch {
      // a failed bookkeeping write must not kill the tick
    }
  }

  status(): SchedulerStatus {
    const persisted = this.state();
    return {
      running: this.timer !== null,
      lastTickAt: this.lastTickAt,
      lastSuccessAt: this.lastSuccessAt,
      jobs: this.jobs().map((j) => ({
        ...j,
        lastRunAt: this.runtime.get(j.id)?.lastRunAt ?? persisted[j.id]?.lastRunAt ?? null,
        lastOutcome: this.runtime.get(j.id)?.lastOutcome ?? persisted[j.id]?.lastOutcome ?? null,
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
    // Re-entrancy guard: a job (doctor probe, review) can take longer than the
    // tick interval. Without this, a second interval fires while the first is
    // still running — concurrent probes and duplicate health alerts. A skipped
    // tick is harmless; due-ness is recomputed on the next one.
    if (this.ticking) return;
    this.ticking = true;
    const nowIso = this.now().toISOString();
    this.lastTickAt = nowIso; // signal 1: alive
    let clean = true;
    try {
      const persisted = this.state();
      for (const job of this.jobs()) {
        if (!job.enabled) continue;
        // ADR-0045: due-ness is decided from the PERSISTED last run, so a restart
        // does not make every job instantly due.
        const lastRunAt =
          this.runtime.get(job.id)?.lastRunAt ?? persisted[job.id]?.lastRunAt ?? null;
        if (lastRunAt) {
          const dueAt = new Date(lastRunAt).getTime() + job.intervalMinutes * 60_000;
          if (this.now().getTime() < dueAt) continue;
        }
        try {
          const outcome = await this.runJob(job);
          this.recordRun(job.id, outcome, nowIso);
        } catch {
          clean = false;
          this.recordRun(job.id, 'error', nowIso);
        }
      }
      if (clean) this.lastSuccessAt = nowIso; // signal 2: productive
    } finally {
      this.ticking = false;
    }
  }

  private async runJob(job: SchedulerJob): Promise<'ok' | 'problem'> {
    switch (job.kind) {
      // ADR-0045. It PROPOSES. It never changes the plan.
      case 'project-review': {
        const projects = job.projectId
          ? [job.projectId]
          : this.kernel
              .listProjects()
              .filter((p) => p.activatedAt)
              .map((p) => p.id);
        let anything = false;
        for (const projectId of projects) {
          if (this.kernel.runProjectReview(projectId, this.now())) anything = true;
        }
        return anything ? 'problem' : 'ok'; // 'problem' = there is something to look at
      }
      // HARMONY-2: what runs / waits / fails, pushed to paired chats. Silent when quiet.
      case 'daily-digest': {
        const projects = job.projectId
          ? [job.projectId]
          : this.kernel
              .listProjects()
              .filter((p) => p.activatedAt)
              .map((p) => p.id);
        for (const projectId of projects) {
          const digest = this.kernel.buildDailyDigest(projectId);
          if (digest) this.kernel.notifyChannels(projectId, digest);
        }
        return 'ok';
      }
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
