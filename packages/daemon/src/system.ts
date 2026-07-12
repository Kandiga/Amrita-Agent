import { runDoctor } from './doctor.ts';
import type { AmritaKernel, LaneStartResult } from './kernel.ts';

/**
 * The System Brain (ADR-0036): Global Amrita's typed verbs over ALL projects.
 * Health/audit are read-only sweeps over existing projections; plan/manage
 * write only through the value-free memory path or the gated lane path.
 */

export const SYSTEM_PROJECT_SLUG = 'system';

/** Ensure + return the reserved system project (the global scope). */
export function ensureSystemProject(kernel: AmritaKernel): { projectId: string } {
  return { projectId: kernel.ensureProject({ slug: SYSTEM_PROJECT_SLUG, name: 'System' }).id };
}

/** The system conversation global chat + watchdog posts land in. */
export function ensureSystemConversation(kernel: AmritaKernel): {
  projectId: string;
  conversationId: string;
} {
  const { projectId } = ensureSystemProject(kernel);
  const existing = kernel.listConversations(projectId).find((c) => c.title === '(global)');
  const conversationId =
    existing?.id ?? kernel.createConversation({ projectId, title: '(global)' }).id;
  return { projectId, conversationId };
}

/**
 * System health (read-only): the doctor + per-project brain counts + the
 * scheduler's two-signal heartbeat (null = no scheduler running — honest).
 */
export async function systemHealth(kernel: AmritaKernel): Promise<{
  ok: boolean;
  doctor: Awaited<ReturnType<typeof runDoctor>>;
  scheduler: ReturnType<AmritaKernel['getSchedulerStatus']>;
  projects: { id: string; slug: string; name: string; records: number; gaps: number }[];
}> {
  const doctor = await runDoctor(kernel);
  const projects = kernel
    .listProjects()
    .filter((p) => p.slug !== SYSTEM_PROJECT_SLUG)
    .map((p) => {
      const brain = kernel.getProjectBrain(p.id);
      return {
        id: p.id,
        slug: p.slug,
        name: p.name,
        records: brain.counts.records,
        gaps: brain.counts.gaps,
      };
    });
  return { ok: doctor.ok, doctor, scheduler: kernel.getSchedulerStatus(), projects };
}

export interface SystemAuditFinding {
  projectId: string;
  slug: string;
  kind: 'missing-brief' | 'unresolved-questions' | 'open-risks' | 'brain-gaps';
  severity: 'low' | 'medium' | 'high';
  detail: string;
}

/**
 * Cross-project audit over existing projections (no probes, no writes unless
 * `record`). The exact class of finding the reorganization audit found by hand
 * becomes a standing capability.
 */
export function systemAudit(
  kernel: AmritaKernel,
  opts: { record?: boolean } = {},
): { findings: SystemAuditFinding[]; recorded: number } {
  const findings: SystemAuditFinding[] = [];
  for (const p of kernel.listProjects()) {
    if (p.slug === SYSTEM_PROJECT_SLUG) continue;
    const c = kernel.getCompanion(p.id);
    if (!c.brief) {
      findings.push({
        projectId: p.id,
        slug: p.slug,
        kind: 'missing-brief',
        severity: 'medium',
        detail: `project ${p.slug} has no brief — the companion cannot steer it`,
      });
    }
    const openQ = c.questions.filter((q) => q.status === 'open').length;
    if (openQ > 0) {
      findings.push({
        projectId: p.id,
        slug: p.slug,
        kind: 'unresolved-questions',
        severity: openQ > 3 ? 'high' : 'medium',
        detail: `${openQ} open question(s) in ${p.slug}`,
      });
    }
    const openR = c.risks.filter((r) => r.status === 'open').length;
    if (openR > 0) {
      findings.push({
        projectId: p.id,
        slug: p.slug,
        kind: 'open-risks',
        severity: 'high',
        detail: `${openR} open risk(s) in ${p.slug}`,
      });
    }
    const brain = kernel.getProjectBrain(p.id);
    if (brain.gaps.length > 0) {
      findings.push({
        projectId: p.id,
        slug: p.slug,
        kind: 'brain-gaps',
        severity: brain.gaps.some((g) => g.severity === 'high') ? 'high' : 'low',
        detail: `${brain.gaps.length} knowledge gap(s) in ${p.slug}`,
      });
    }
  }

  let recorded = 0;
  if (opts.record && findings.length > 0) {
    const ctx = ensureSystemConversation(kernel);
    for (const f of findings.slice(0, 20)) {
      kernel.captureKnowledge({
        projectId: ctx.projectId,
        conversationId: ctx.conversationId,
        kind: 'project-context',
        title: `[audit] ${f.slug}: ${f.kind}`,
        body: f.detail,
        tags: ['system-audit', f.severity],
        source: 'system:audit',
      });
      recorded++;
    }
  }
  return { findings, recorded };
}

/** Draft a plan record into a TARGET project's brain. Never executes. */
export function systemPlan(
  kernel: AmritaKernel,
  input: { projectId: string; title: string; body?: string },
): { entryId: string; kind: string } {
  const project = kernel.getProject({ id: input.projectId });
  if (!project) throw new Error(`no such project: ${input.projectId}`);
  const conversation =
    kernel.listConversations(project.id).find((c) => c.title === '(default)') ??
    kernel.createConversation({ projectId: project.id, title: '(default)' });
  return kernel.captureKnowledge({
    projectId: project.id,
    conversationId: conversation.id,
    kind: 'project-context',
    title: `[plan] ${input.title}`,
    ...(input.body ? { body: input.body } : {}),
    tags: ['system-plan'],
    source: 'system:plan',
  });
}

/**
 * Delegate a goal as a lane in the target project's default conversation —
 * through the standard runner + approval gates (ADR-0015/0021 unchanged).
 */
export async function systemManage(
  kernel: AmritaKernel,
  input: { projectId: string; goal: string; kind?: string; dryRun?: boolean },
): Promise<LaneStartResult> {
  const project = kernel.getProject({ id: input.projectId });
  if (!project) throw new Error(`no such project: ${input.projectId}`);
  const conversation =
    kernel.listConversations(project.id).find((c) => c.title === '(default)') ??
    kernel.createConversation({ projectId: project.id, title: '(default)' });
  return kernel.startLane({
    conversationId: conversation.id,
    goal: input.goal,
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
  });
}
