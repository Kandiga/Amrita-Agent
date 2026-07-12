import type { AmritaKernel } from './kernel.ts';

/**
 * The operator-command service (reorganization R2, audit R-9): the ONE place
 * `/status /lanes /approvals /approve /deny /stop /help` are interpreted.
 * Channels (Telegram today, WhatsApp/terminal later) only render the returned
 * text — no channel re-implements approval disambiguation or status math, so
 * every surface answers identically. Replies are plain text and value-free.
 */

export const OPERATOR_COMMANDS = [
  '/status',
  '/lanes',
  '/approvals',
  '/approve',
  '/deny',
  '/stop',
  '/help',
] as const;

/** True when the text looks like an operator command (starts with `/`). */
export function isOperatorCommand(text: string): boolean {
  return text.trim().startsWith('/');
}

export async function runOperatorCommand(
  kernel: AmritaKernel,
  text: string,
  projectId: string,
): Promise<string> {
  const [cmd, ...args] = text.trim().split(/\s+/);
  switch ((cmd ?? '').toLowerCase()) {
    case '/status': {
      const c = kernel.getCompanion(projectId);
      const tasks = kernel.listTasks({ projectId });
      const openTasks = tasks.filter((t) => t.status !== 'done' && t.status !== 'dropped');
      const openQ = c.questions.filter((q) => q.status === 'open');
      const openR = c.risks.filter((r) => r.status === 'open');
      const active = kernel
        .listLanes({ projectId })
        .filter((l) => l.status === 'spawned' || l.status === 'running' || l.status === 'merging');
      const pending = kernel.listPendingApprovals().filter((a) => a.projectId === projectId);
      return [
        c.brief ? `goal: ${c.brief.goal}` : 'no brief yet',
        `tasks: ${openTasks.length} open / ${tasks.length} total`,
        `questions: ${openQ.length} open · risks: ${openR.length} open`,
        `lanes: ${active.length} active · approvals: ${pending.length} pending`,
        ...(pending.length > 0 ? ['→ /approvals to review'] : []),
      ].join('\n');
    }
    case '/lanes': {
      const lanes = kernel.listLanes({ projectId }).slice(-5).reverse();
      if (lanes.length === 0) return 'no lanes yet';
      return lanes
        .map((l) => {
          let goal = '';
          try {
            goal = (JSON.parse(l.mandateJson) as { goal?: string }).goal ?? '';
          } catch {
            goal = '';
          }
          return `[${l.status}] ${l.id.slice(0, 8)} ${goal.slice(0, 60)}`;
        })
        .join('\n');
    }
    case '/approvals': {
      const pending = kernel.listPendingApprovals().filter((a) => a.projectId === projectId);
      if (pending.length === 0) return 'no pending approvals';
      return pending
        .map(
          (a) =>
            `${a.approvalId.slice(0, 8)} · ${a.action}${a.detail ? ` · ${a.detail.slice(0, 80)}` : ''}`,
        )
        .concat('reply: /approve <id> or /deny <id>')
        .join('\n');
    }
    case '/approve':
    case '/deny': {
      const prefix = args[0];
      if (!prefix) return `usage: ${cmd} <approval id prefix>`;
      const match = kernel
        .listPendingApprovals()
        .filter((a) => a.projectId === projectId && a.approvalId.startsWith(prefix.toUpperCase()));
      if (match.length === 0) return `no pending approval matches "${prefix}"`;
      if (match.length > 1)
        return `"${prefix}" is ambiguous (${match.length} matches) — use more characters`;
      const first = match[0];
      if (!first) return `no pending approval matches "${prefix}"`;
      const decision = cmd?.toLowerCase() === '/approve' ? 'allow' : 'deny';
      kernel.resolveApproval(first.approvalId, decision);
      return `${decision === 'allow' ? 'approved' : 'denied'} ${first.approvalId.slice(0, 8)} · ${first.action}`;
    }
    case '/stop': {
      const prefix = args[0];
      if (!prefix) return 'usage: /stop <lane id prefix>';
      const lanes = kernel
        .listLanes({ projectId })
        .filter(
          (l) =>
            l.id.startsWith(prefix.toUpperCase()) &&
            (l.status === 'spawned' || l.status === 'running' || l.status === 'merging'),
        );
      if (lanes.length === 0) return `no active lane matches "${prefix}"`;
      if (lanes.length > 1) return `"${prefix}" is ambiguous (${lanes.length} matches)`;
      const lane = lanes[0];
      if (!lane) return `no active lane matches "${prefix}"`;
      const r = await kernel.cancelLane(lane.id);
      return r.cancelled
        ? `stopped lane ${lane.id.slice(0, 8)}`
        : `lane ${lane.id.slice(0, 8)} was not active`;
    }
    case '/help':
      return [
        '/status — project at a glance',
        '/lanes — recent lanes',
        '/approvals — pending operator approvals',
        '/approve <id> · /deny <id>',
        '/stop <lane id> — cancel an active lane',
        'anything else — chat with Amrita',
      ].join('\n');
    default:
      return `unknown command ${cmd} — try /help`;
  }
}
