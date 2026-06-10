import { getDb } from '../core/store/db.ts';
import type { CronJob } from '../shared/types.ts';
import { nextRun } from './cron.ts';
import { runAgent } from '../core/agent/loop.ts';
import { createSession } from '../core/store/sessions.ts';
import { getProject } from '../projects/manager.ts';
import { audit } from '../core/store/audit.ts';
import { id, log, now } from '../shared/util.ts';

/**
 * Cron scheduler (Hermes pattern, including its safety rule): scheduled runs
 * always strip interactive/scheduling/connector toolsets so an unattended job
 * can't message arbitrary people, schedule more jobs, or launch big agents.
 */

interface JobRow {
  id: string;
  name: string;
  schedule: string;
  prompt: string;
  project_slug: string | null;
  delivery: string | null;
  enabled: number;
  last_run_at: number | null;
  next_run_at: number | null;
}

function rowToJob(r: JobRow): CronJob {
  return {
    id: r.id,
    name: r.name,
    schedule: r.schedule,
    prompt: r.prompt,
    projectSlug: r.project_slug,
    delivery: r.delivery ? JSON.parse(r.delivery) : null,
    enabled: Boolean(r.enabled),
    lastRunAt: r.last_run_at,
    nextRunAt: r.next_run_at,
  };
}

export function listJobs(): CronJob[] {
  return (getDb().prepare(`SELECT * FROM cron_jobs`).all() as unknown as JobRow[]).map(rowToJob);
}

export function createJob(
  job: Omit<CronJob, 'id' | 'lastRunAt' | 'nextRunAt'>,
): CronJob {
  const next = nextRun(job.schedule);
  const full: CronJob = {
    ...job,
    id: id('cron'),
    lastRunAt: null,
    nextRunAt: next ? next.getTime() : null,
  };
  getDb()
    .prepare(
      `INSERT INTO cron_jobs (id, name, schedule, prompt, project_slug, delivery, enabled, last_run_at, next_run_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    )
    .run(
      full.id,
      full.name,
      full.schedule,
      full.prompt,
      full.projectSlug,
      full.delivery ? JSON.stringify(full.delivery) : null,
      full.enabled ? 1 : 0,
      full.nextRunAt,
    );
  return full;
}

export function deleteJob(jobId: string): void {
  getDb().prepare(`DELETE FROM cron_jobs WHERE id = ?`).run(jobId);
}

async function executeJob(job: CronJob, deliver?: (chatId: string, text: string) => Promise<void>): Promise<void> {
  audit('cron-run', { job: job.id, name: job.name }, { projectSlug: job.projectSlug });
  const project = job.projectSlug ? getProject(job.projectSlug) : null;
  const session = createSession(job.projectSlug, 'cron');
  let output = '';
  try {
    for await (const event of runAgent({
      sessionId: session.id,
      project,
      channel: 'cron',
      userText: job.prompt,
      signal: AbortSignal.timeout(15 * 60 * 1000),
      toolFilter: { stripToolsets: ['scheduling', 'connectors'] },
    })) {
      if (event.type === 'text') output += event.delta;
      if (event.type === 'error') output += `\n⚠️ ${event.message}`;
    }
  } catch (err) {
    output += `\n⚠️ cron job failed: ${err instanceof Error ? err.message : err}`;
  }
  if (job.delivery && deliver) {
    await deliver(job.delivery.chatId, `⏰ *${job.name}*\n\n${output.trim()}`).catch((err) =>
      log('cron', `delivery failed: ${err}`),
    );
  }
}

let deliverFn: ((channel: string, chatId: string, text: string) => Promise<void>) | null = null;

/** The daemon wires channel delivery here once adapters are up. */
export function setCronDelivery(fn: (channel: string, chatId: string, text: string) => Promise<void>): void {
  deliverFn = fn;
}

export function startScheduler(): void {
  const tick = async () => {
    const due = listJobs().filter(
      (j) => j.enabled && j.nextRunAt !== null && j.nextRunAt <= now(),
    );
    for (const job of due) {
      // Advance next_run_at BEFORE executing so a crash can't double-run.
      const next = nextRun(job.schedule);
      getDb()
        .prepare(`UPDATE cron_jobs SET last_run_at = ?, next_run_at = ? WHERE id = ?`)
        .run(now(), next ? next.getTime() : null, job.id);
      await executeJob(job, job.delivery && deliverFn
        ? (chatId, text) => deliverFn!(job.delivery!.channel, chatId, text)
        : undefined);
    }
  };
  setInterval(() => void tick().catch((err) => log('cron', `tick error: ${err}`)), 60_000).unref();
  log('cron', `scheduler started (${listJobs().length} job(s))`);
}
