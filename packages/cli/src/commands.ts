import { CliError, type InProcessClient } from './client.ts';
import { ensureDefaultConversation, resolveProjectId, resolveWriteContext } from './context.ts';
import { strFlag } from './parse.ts';

export interface CommandCtx {
  positionals: string[];
  flags: Record<string, string | boolean>;
}
export interface Command {
  describe: string;
  run(client: InProcessClient, ctx: CommandCtx): Promise<{ result: unknown; summary: string }>;
}

interface ProjectLite {
  id: string;
  slug: string;
  name: string;
}
interface ConvLite {
  id: string;
  title: string | null;
}
interface TaskLite {
  id: string;
  projectId: string;
  conversationId: string | null;
  status: string;
  title: string;
}
interface MemLite {
  id: string;
  content: string;
}
interface ChatTurnLite {
  provider: string;
  model: string;
  text: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
}
interface ProviderInfoLite {
  id: string;
  kind: string;
  available: boolean;
  configuredAccounts: number;
  envReady: boolean;
}
interface HealthLite {
  schemaVersion: number;
  dbPath: string;
  counts: { projects: number; conversations: number; messages: number; events: number };
  lanes?: { realExecution: boolean; active: number };
}
interface LaneLite {
  id: string;
  status: string;
  kind: string;
  mandateJson: string;
  mergeJson?: string | null;
}
interface LaneStartLite {
  laneId: string;
  status: string;
  dryRun: boolean;
  detached: boolean;
  report: { exit: string } | null;
  error?: string;
}
interface LaneCancelLite {
  laneId: string;
  cancelled: boolean;
  status: string | null;
}

function laneGoal(lane: LaneLite): string {
  try {
    const goal = (JSON.parse(lane.mandateJson) as { goal?: string }).goal;
    return goal ? `“${goal.slice(0, 60)}”` : '';
  } catch {
    return '';
  }
}

interface CompanionLite {
  brief: {
    goal: string;
    audience: string | null;
    successCriteria: string[];
    scope: string[];
    noScope: string[];
  } | null;
  questions: { id: string; text: string; status: string }[];
  risks: { id: string; text: string; status: string; severity: string | null }[];
  milestones: { id: string; title: string; status: string; targetDate: string | null }[];
}

interface TimelineEventLite {
  ts: string;
  type: string;
  payload: Record<string, unknown>;
}

/** A one-line human summary for a timeline event (no protocol details leaked). */
function timelineSummary(e: TimelineEventLite): string {
  const p = e.payload;
  const text = p.text ?? p.title ?? p.goal ?? p.note ?? p.reason ?? p.resolution ?? '';
  return typeof text === 'string' ? text.slice(0, 80) : '';
}

interface DoctorCheckLite {
  label: string;
  status: 'ok' | 'warn' | 'fail';
  detail?: string;
}
interface DoctorReportLite {
  ok: boolean;
  status: string;
  sections: { title: string; checks: DoctorCheckLite[] }[];
  fixes: string[];
}

const DOCTOR_MARK: Record<DoctorCheckLite['status'], string> = {
  ok: '✓',
  warn: '!',
  fail: '✗',
};

/** Render a doctor report: ◆ sections, ✓/!/✗ checks, numbered exact-fix footer (PLAN §5.4). */
export function renderDoctor(r: DoctorReportLite): string {
  const lines: string[] = [];
  for (const section of r.sections) {
    lines.push(`◆ ${section.title}`);
    for (const c of section.checks) {
      lines.push(`  ${DOCTOR_MARK[c.status]} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
    }
  }
  if (r.fixes.length > 0) {
    lines.push('', 'Run these to fix:');
    r.fixes.forEach((fix, i) => lines.push(`  ${i + 1}. ${fix}`));
  }
  lines.push(
    '',
    r.ok ? `doctor: ${r.status === 'ok' ? 'all good' : 'ok with warnings'}` : 'doctor: FAILING',
  );
  return lines.join('\n');
}

export const COMMANDS: Record<string, Command> = {
  health: {
    describe: 'show daemon health and row counts',
    async run(client) {
      const h = await client.call<HealthLite>('health');
      const c = h.counts;
      const lanes = h.lanes
        ? `\nlanes real-execution ${h.lanes.realExecution ? 'enabled' : 'disabled'} · ${h.lanes.active} active`
        : '';
      return {
        result: h,
        summary:
          `amritad · schema v${h.schemaVersion} · ${h.dbPath}\n` +
          `projects ${c.projects} · conversations ${c.conversations} · messages ${c.messages} · events ${c.events}${lanes}`,
      };
    },
  },

  doctor: {
    describe: 'grouped setup/health checks with exact fix commands',
    async run(client) {
      const r = await client.call<DoctorReportLite>('doctor');
      return { result: r, summary: renderDoctor(r) };
    },
  },

  'project ensure': {
    describe: 'create-or-get a project by slug',
    async run(client, { positionals, flags }) {
      const slug = positionals[0];
      if (!slug) throw new CliError('usage: amrita project ensure <slug> [--name NAME]');
      const p = await client.call<ProjectLite>('project.ensure', {
        slug,
        name: strFlag(flags, 'name') ?? slug,
      });
      return { result: p, summary: `project ${p.slug}  ${p.id}` };
    },
  },
  'project list': {
    describe: 'list projects',
    async run(client) {
      const ps = await client.call<ProjectLite[]>('project.list');
      return {
        result: ps,
        summary: ps.length
          ? ps.map((p) => `${p.slug}\t${p.id}\t${p.name}`).join('\n')
          : '(no projects)',
      };
    },
  },

  'conversation create': {
    describe: 'create a conversation under a project',
    async run(client, { flags }) {
      const project = strFlag(flags, 'project');
      if (!project) throw new CliError('usage: amrita conversation create --project <ID_OR_SLUG>');
      const projectId = await resolveProjectId(client, project);
      const title = strFlag(flags, 'title');
      const parent = strFlag(flags, 'parent');
      const c = await client.call<ConvLite>('conversation.create', {
        projectId,
        ...(title ? { title } : {}),
        ...(parent ? { parentId: parent } : {}),
      });
      return { result: c, summary: `conversation ${c.id}` };
    },
  },
  'conversation tree': {
    describe: 'print a conversation and its descendants',
    async run(client, { positionals }) {
      const id = positionals[0];
      if (!id) throw new CliError('usage: amrita conversation tree <CONVERSATION_ID>');
      const nodes = await client.call<ConvLite[]>('conversation.tree', { conversationId: id });
      return {
        result: nodes,
        summary: nodes.map((n) => `${n.id}  ${n.title ?? '(untitled)'}`).join('\n') || '(empty)',
      };
    },
  },

  'message user': {
    describe: 'record a user message in a conversation',
    async run(client, { positionals }) {
      const conversationId = positionals[0];
      const text = positionals.slice(1).join(' ');
      if (!conversationId || !text) {
        throw new CliError('usage: amrita message user <CONVERSATION_ID> <TEXT>');
      }
      const ctx = await resolveWriteContext(client, { conversation: conversationId });
      const r = await client.call<{ messageId: string; event: { seq: number } }>(
        'message.user.record',
        { projectId: ctx.projectId, conversationId: ctx.conversationId, text, channel: 'cli' },
      );
      return { result: r, summary: `recorded message ${r.messageId} (seq ${r.event.seq})` };
    },
  },

  'task create': {
    describe: 'create a task',
    async run(client, { flags }) {
      const project = strFlag(flags, 'project');
      const title = strFlag(flags, 'title');
      if (!project || !title) {
        throw new CliError('usage: amrita task create --project <ID_OR_SLUG> --title TITLE');
      }
      const ctx = await resolveWriteContext(client, {
        project,
        conversation: strFlag(flags, 'conversation'),
      });
      const r = await client.call<{ taskId: string }>('tasks.create', {
        projectId: ctx.projectId,
        conversationId: ctx.conversationId,
        title,
      });
      return { result: r, summary: `task ${r.taskId}` };
    },
  },
  'task list': {
    describe: 'list tasks in a project',
    async run(client, { flags }) {
      const project = strFlag(flags, 'project');
      if (!project) throw new CliError('usage: amrita task list --project <ID_OR_SLUG>');
      const ts = await client.call<TaskLite[]>('tasks.list', {
        projectId: await resolveProjectId(client, project),
      });
      return {
        result: ts,
        summary: ts.length
          ? ts.map((t) => `[${t.status}] ${t.title}  ${t.id}`).join('\n')
          : '(no tasks)',
      };
    },
  },
  'task complete': {
    describe: 'mark a task done',
    async run(client, { positionals }) {
      const taskId = positionals[0];
      if (!taskId) throw new CliError('usage: amrita task complete <TASK_ID>');
      const task = (await client.call<TaskLite[]>('tasks.list', {})).find((t) => t.id === taskId);
      if (!task) throw new CliError(`task not found: ${taskId}`, 'not_found');
      const conversationId =
        task.conversationId ?? (await ensureDefaultConversation(client, task.projectId));
      await client.call('tasks.complete', { projectId: task.projectId, conversationId, taskId });
      return { result: { ok: true, taskId }, summary: `completed ${taskId}` };
    },
  },

  'decision record': {
    describe: 'record a decision',
    async run(client, { flags }) {
      const project = strFlag(flags, 'project');
      const text = strFlag(flags, 'text');
      if (!project || !text) {
        throw new CliError('usage: amrita decision record --project <ID_OR_SLUG> --text TEXT');
      }
      const ctx = await resolveWriteContext(client, {
        project,
        conversation: strFlag(flags, 'conversation'),
      });
      const r = await client.call<{ decisionId: string }>('decisions.record', {
        projectId: ctx.projectId,
        conversationId: ctx.conversationId,
        text,
      });
      return { result: r, summary: `decision ${r.decisionId}` };
    },
  },

  'brief get': {
    describe: 'show the project brief (goal, success criteria, scope)',
    async run(client, { flags }) {
      const project = strFlag(flags, 'project');
      if (!project) throw new CliError('usage: amrita brief get --project <ID_OR_SLUG>');
      const projectId = await resolveProjectId(client, project);
      const c = await client.call<CompanionLite>('projects.companion.get', { projectId });
      if (!c.brief)
        return { result: null, summary: '(no brief yet — set one with: amrita brief set)' };
      const b = c.brief;
      const lines = [
        `goal: ${b.goal}`,
        ...(b.audience ? [`audience: ${b.audience}`] : []),
        ...(b.successCriteria.length ? [`success: ${b.successCriteria.join(' · ')}`] : []),
        ...(b.scope.length ? [`scope: ${b.scope.join(' · ')}`] : []),
        ...(b.noScope.length ? [`out of scope: ${b.noScope.join(' · ')}`] : []),
      ];
      return { result: b, summary: lines.join('\n') };
    },
  },
  'brief set': {
    describe: 'create/replace the project brief (lists are ;-separated)',
    async run(client, { flags }) {
      const project = strFlag(flags, 'project');
      const goal = strFlag(flags, 'goal');
      if (!project || !goal) {
        throw new CliError(
          'usage: amrita brief set --project <ID_OR_SLUG> --goal TEXT [--audience TEXT] [--criteria a;b] [--scope a;b] [--no-scope a;b]',
        );
      }
      const list = (name: string) =>
        (strFlag(flags, name) ?? '')
          .split(';')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
      const ctx = await resolveWriteContext(client, { project });
      const audience = strFlag(flags, 'audience');
      await client.call('projects.brief.update', {
        projectId: ctx.projectId,
        conversationId: ctx.conversationId,
        goal,
        ...(audience ? { audience } : {}),
        successCriteria: list('criteria'),
        scope: list('scope'),
        noScope: list('no-scope'),
      });
      return { result: { ok: true, goal }, summary: `brief set · ${goal}` };
    },
  },

  'question list': {
    describe: 'list project questions (open/resolved/dropped)',
    async run(client, { flags }) {
      const project = strFlag(flags, 'project');
      if (!project) throw new CliError('usage: amrita question list --project <ID_OR_SLUG>');
      const projectId = await resolveProjectId(client, project);
      const c = await client.call<CompanionLite>('projects.companion.get', { projectId });
      return {
        result: c.questions,
        summary: c.questions.length
          ? c.questions.map((q) => `[${q.status}] ${q.text}  ${q.id}`).join('\n')
          : '(no questions yet)',
      };
    },
  },
  'question open': {
    describe: 'record an open question for the project',
    async run(client, { positionals, flags }) {
      const project = strFlag(flags, 'project');
      const text = positionals.join(' ');
      if (!project || !text) {
        throw new CliError('usage: amrita question open <TEXT> --project <ID_OR_SLUG>');
      }
      const ctx = await resolveWriteContext(client, { project });
      const r = await client.call<{ questionId: string }>('projects.questions.open', {
        projectId: ctx.projectId,
        conversationId: ctx.conversationId,
        text,
      });
      return { result: r, summary: `question ${r.questionId}` };
    },
  },
  'question resolve': {
    describe: 'resolve a question with a note (--note) and/or a decision (--decision)',
    async run(client, { positionals, flags }) {
      const questionId = positionals[0];
      const note = strFlag(flags, 'note');
      const decision = strFlag(flags, 'decision');
      const project = strFlag(flags, 'project');
      if (!questionId || !project || (!note && !decision)) {
        throw new CliError(
          'usage: amrita question resolve <QUESTION_ID> --project <ID_OR_SLUG> (--note TEXT | --decision DECISION_ID)',
        );
      }
      const ctx = await resolveWriteContext(client, { project });
      await client.call('projects.questions.resolve', {
        projectId: ctx.projectId,
        conversationId: ctx.conversationId,
        questionId,
        ...(note ? { resolution: note } : {}),
        ...(decision ? { resolvedByDecisionId: decision } : {}),
      });
      return { result: { ok: true, questionId }, summary: `resolved ${questionId}` };
    },
  },
  'question drop': {
    describe: 'drop a question with a reason',
    async run(client, { positionals, flags }) {
      const questionId = positionals[0];
      const reason = strFlag(flags, 'reason');
      const project = strFlag(flags, 'project');
      if (!questionId || !project || !reason) {
        throw new CliError(
          'usage: amrita question drop <QUESTION_ID> --project <ID_OR_SLUG> --reason TEXT',
        );
      }
      const ctx = await resolveWriteContext(client, { project });
      await client.call('projects.questions.drop', {
        projectId: ctx.projectId,
        conversationId: ctx.conversationId,
        questionId,
        reason,
      });
      return { result: { ok: true, questionId }, summary: `dropped ${questionId}` };
    },
  },

  'risk list': {
    describe: 'list project risks',
    async run(client, { flags }) {
      const project = strFlag(flags, 'project');
      if (!project) throw new CliError('usage: amrita risk list --project <ID_OR_SLUG>');
      const projectId = await resolveProjectId(client, project);
      const c = await client.call<CompanionLite>('projects.companion.get', { projectId });
      return {
        result: c.risks,
        summary: c.risks.length
          ? c.risks
              .map((r) => `[${r.status}]${r.severity ? ` (${r.severity})` : ''} ${r.text}  ${r.id}`)
              .join('\n')
          : '(no risks yet)',
      };
    },
  },
  'risk open': {
    describe: 'record a risk (--severity low|medium|high)',
    async run(client, { positionals, flags }) {
      const project = strFlag(flags, 'project');
      const text = positionals.join(' ');
      if (!project || !text) {
        throw new CliError(
          'usage: amrita risk open <TEXT> --project <ID_OR_SLUG> [--severity low|medium|high]',
        );
      }
      const severity = strFlag(flags, 'severity');
      const ctx = await resolveWriteContext(client, { project });
      const r = await client.call<{ riskId: string }>('projects.risks.open', {
        projectId: ctx.projectId,
        conversationId: ctx.conversationId,
        text,
        ...(severity ? { severity } : {}),
      });
      return { result: r, summary: `risk ${r.riskId}` };
    },
  },
  'risk resolve': {
    describe: 'resolve a risk with a note (--note) and/or a decision (--decision)',
    async run(client, { positionals, flags }) {
      const riskId = positionals[0];
      const note = strFlag(flags, 'note');
      const decision = strFlag(flags, 'decision');
      const project = strFlag(flags, 'project');
      if (!riskId || !project || (!note && !decision)) {
        throw new CliError(
          'usage: amrita risk resolve <RISK_ID> --project <ID_OR_SLUG> (--note TEXT | --decision DECISION_ID)',
        );
      }
      const ctx = await resolveWriteContext(client, { project });
      await client.call('projects.risks.resolve', {
        projectId: ctx.projectId,
        conversationId: ctx.conversationId,
        riskId,
        ...(note ? { resolution: note } : {}),
        ...(decision ? { resolvedByDecisionId: decision } : {}),
      });
      return { result: { ok: true, riskId }, summary: `resolved ${riskId}` };
    },
  },
  'risk drop': {
    describe: 'drop a risk with a reason',
    async run(client, { positionals, flags }) {
      const riskId = positionals[0];
      const reason = strFlag(flags, 'reason');
      const project = strFlag(flags, 'project');
      if (!riskId || !project || !reason) {
        throw new CliError(
          'usage: amrita risk drop <RISK_ID> --project <ID_OR_SLUG> --reason TEXT',
        );
      }
      const ctx = await resolveWriteContext(client, { project });
      await client.call('projects.risks.drop', {
        projectId: ctx.projectId,
        conversationId: ctx.conversationId,
        riskId,
        reason,
      });
      return { result: { ok: true, riskId }, summary: `dropped ${riskId}` };
    },
  },

  'milestone list': {
    describe: 'list project milestones',
    async run(client, { flags }) {
      const project = strFlag(flags, 'project');
      if (!project) throw new CliError('usage: amrita milestone list --project <ID_OR_SLUG>');
      const projectId = await resolveProjectId(client, project);
      const c = await client.call<CompanionLite>('projects.companion.get', { projectId });
      return {
        result: c.milestones,
        summary: c.milestones.length
          ? c.milestones
              .map(
                (m) =>
                  `[${m.status}] ${m.title}${m.targetDate ? ` (→ ${m.targetDate})` : ''}  ${m.id}`,
              )
              .join('\n')
          : '(no milestones yet)',
      };
    },
  },
  'milestone create': {
    describe: 'create a milestone (--target YYYY-MM-DD)',
    async run(client, { flags }) {
      const project = strFlag(flags, 'project');
      const title = strFlag(flags, 'title');
      if (!project || !title) {
        throw new CliError(
          'usage: amrita milestone create --project <ID_OR_SLUG> --title TITLE [--target YYYY-MM-DD] [--description TEXT]',
        );
      }
      const target = strFlag(flags, 'target');
      const description = strFlag(flags, 'description');
      const ctx = await resolveWriteContext(client, { project });
      const r = await client.call<{ milestoneId: string }>('projects.milestones.create', {
        projectId: ctx.projectId,
        conversationId: ctx.conversationId,
        title,
        ...(target ? { targetDate: target } : {}),
        ...(description ? { description } : {}),
      });
      return { result: r, summary: `milestone ${r.milestoneId}` };
    },
  },
  'milestone complete': {
    describe: 'mark a milestone done',
    async run(client, { positionals, flags }) {
      const milestoneId = positionals[0];
      const project = strFlag(flags, 'project');
      if (!milestoneId || !project) {
        throw new CliError(
          'usage: amrita milestone complete <MILESTONE_ID> --project <ID_OR_SLUG>',
        );
      }
      const ctx = await resolveWriteContext(client, { project });
      await client.call('projects.milestones.complete', {
        projectId: ctx.projectId,
        conversationId: ctx.conversationId,
        milestoneId,
      });
      return { result: { ok: true, milestoneId }, summary: `completed ${milestoneId}` };
    },
  },

  timeline: {
    describe: 'project activity, newest first (derived from the event log)',
    async run(client, { flags }) {
      const project = strFlag(flags, 'project');
      if (!project) throw new CliError('usage: amrita timeline --project <ID_OR_SLUG> [--limit N]');
      const projectId = await resolveProjectId(client, project);
      const limitRaw = strFlag(flags, 'limit');
      const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
      const events = await client.call<TimelineEventLite[]>('projects.timeline.list', {
        projectId,
        ...(limit && Number.isFinite(limit) ? { limit } : {}),
      });
      return {
        result: events,
        summary: events.length
          ? events.map((e) => `${e.ts}  ${e.type}  ${timelineSummary(e)}`).join('\n')
          : '(no activity yet)',
      };
    },
  },

  'memory put': {
    describe: 'store a memory entry',
    async run(client, { flags }) {
      const scope = strFlag(flags, 'scope');
      const content = strFlag(flags, 'content');
      if (scope !== 'user' && scope !== 'project') {
        throw new CliError('--scope must be "user" or "project"');
      }
      if (!content) throw new CliError('--content is required');
      const project = strFlag(flags, 'project');
      if (scope === 'project' && !project) {
        throw new CliError('--project is required for --scope project');
      }
      const ctx = await resolveWriteContext(client, project ? { project } : {});
      const r = await client.call<{ entryId: string }>('memory.put', {
        projectId: ctx.projectId,
        conversationId: ctx.conversationId,
        scope,
        content,
      });
      return { result: r, summary: `memory ${r.entryId}` };
    },
  },
  'memory search': {
    describe: 'full-text search memory',
    async run(client, { positionals, flags }) {
      const query = positionals.join(' ');
      if (!query) throw new CliError('usage: amrita memory search <QUERY>');
      const scope = strFlag(flags, 'scope');
      const project = strFlag(flags, 'project');
      const ms = await client.call<MemLite[]>('memory.search', {
        query,
        ...(scope ? { scope } : {}),
        ...(project ? { projectId: await resolveProjectId(client, project) } : {}),
      });
      return {
        result: ms,
        summary: ms.length ? ms.map((m) => `${m.content}  (${m.id})`).join('\n') : '(no matches)',
      };
    },
  },

  'account connect': {
    describe: 'register a provider account (no secret value)',
    async run(client, { flags }) {
      const provider = strFlag(flags, 'provider');
      if (!provider) {
        throw new CliError('usage: amrita account connect --provider PROVIDER [--label LABEL]');
      }
      const label = strFlag(flags, 'label');
      const authMode = strFlag(flags, 'auth-mode') ?? 'api_key';
      const ctx = await resolveWriteContext(client, {});
      const r = await client.call<{ accountId: string }>('accounts.connect', {
        projectId: ctx.projectId,
        conversationId: ctx.conversationId,
        provider,
        authMode,
        ...(label ? { label } : {}),
      });
      return {
        result: r,
        summary: `account ${r.accountId}  ${provider}${label ? ` · ${label}` : ''}`,
      };
    },
  },
  'account bind-secret': {
    describe: 'bind an account to an env-var NAME (never a secret value)',
    async run(client, { positionals }) {
      const accountId = positionals[0];
      const envName = positionals[1];
      if (!accountId || !envName) {
        throw new CliError('usage: amrita account bind-secret <ACCOUNT_ID> <ENV_NAME>');
      }
      await client.call('accounts.bindSecretRef', { accountId, envName });
      return {
        result: { ok: true, accountId, secretRef: envName },
        summary: `bound ${accountId} → ${envName}`,
      };
    },
  },
  'account status': {
    describe: 'show provider config status',
    async run(client, { positionals }) {
      const accountId = positionals[0];
      if (!accountId) throw new CliError('usage: amrita account status <ACCOUNT_ID>');
      const r = await client.call<{ status: string | null }>('accounts.configStatus', {
        accountId,
      });
      return { result: r, summary: `status: ${r.status ?? 'unknown'}` };
    },
  },

  chat: {
    describe: 'run a chat turn (mock provider by default)',
    async run(client, { positionals, flags }) {
      const text = positionals.join(' ');
      if (!text) {
        throw new CliError(
          'usage: amrita chat <TEXT> [--project ID_OR_SLUG] [--conversation ID] [--provider mock|anthropic|openai] [--role fast|main|deep] [--model MODEL]',
        );
      }
      const ctx = await resolveWriteContext(client, {
        project: strFlag(flags, 'project'),
        conversation: strFlag(flags, 'conversation'),
      });
      const provider = strFlag(flags, 'provider');
      const role = strFlag(flags, 'role');
      const model = strFlag(flags, 'model');
      const turn = await client.call<ChatTurnLite>('chat.turn', {
        conversationId: ctx.conversationId,
        text,
        channel: 'cli',
        ...(provider ? { provider } : {}),
        ...(role ? { role } : {}),
        ...(model ? { model } : {}),
      });
      const u = turn.usage;
      const meta = `(${turn.provider} · ${turn.model}${u ? ` · ${u.inputTokens}/${u.outputTokens} tok` : ''})`;
      return { result: turn, summary: `${turn.text ?? '(no reply)'}\n${meta}` };
    },
  },

  'role list': {
    describe: 'show fast/main/deep role bindings and what each resolves to',
    async run(client) {
      const r = await client.call<{
        roles: {
          role: string;
          binding: { provider: string; model?: string } | null;
          resolvesTo: string;
          via: string;
        }[];
      }>('providers.roles');
      return {
        result: r,
        summary: r.roles
          .map(
            (x) =>
              `${x.role}\t→ ${x.resolvesTo}${x.binding?.model ? ` (${x.binding.model})` : ''}\t[${x.via}]`,
          )
          .join('\n'),
      };
    },
  },
  'role set': {
    describe: 'bind a role (fast|main|deep) to a provider (optionally a model)',
    async run(client, { positionals, flags }) {
      const role = positionals[0];
      const provider = positionals[1];
      if (!role || !provider || !['fast', 'main', 'deep'].includes(role)) {
        throw new CliError('usage: amrita role set <fast|main|deep> <provider> [--model MODEL]');
      }
      const known = await client.call<{ id: string }[]>('providers.list');
      if (!known.some((p) => p.id === provider)) {
        throw new CliError(
          `unknown provider '${provider}' (known: ${known.map((p) => p.id).join(', ')})`,
        );
      }
      const model = strFlag(flags, 'model');
      const ctx = await resolveWriteContext(client, {});
      await client.call('settings.update', {
        projectId: ctx.projectId,
        conversationId: ctx.conversationId,
        key: `providers.role.${role}`,
        value: { provider, ...(model ? { model } : {}) },
      });
      return {
        result: { role, provider, ...(model ? { model } : {}) },
        summary: `role ${role} → ${provider}${model ? ` (${model})` : ''}`,
      };
    },
  },
  'role clear': {
    describe: 'remove a role binding (the role falls back to auto)',
    async run(client, { positionals }) {
      const role = positionals[0];
      if (!role || !['fast', 'main', 'deep'].includes(role)) {
        throw new CliError('usage: amrita role clear <fast|main|deep>');
      }
      const ctx = await resolveWriteContext(client, {});
      await client.call('settings.update', {
        projectId: ctx.projectId,
        conversationId: ctx.conversationId,
        key: `providers.role.${role}`,
        value: null,
      });
      return { result: { role, cleared: true }, summary: `role ${role} → auto` };
    },
  },

  'provider list': {
    describe: 'list chat providers and availability',
    async run(client) {
      const ps = await client.call<ProviderInfoLite[]>('providers.list');
      const summary = ps
        .map((p) => {
          const detail =
            p.kind === 'real'
              ? ` (${p.configuredAccounts} account(s), env ${p.envReady ? 'ready' : 'missing'})`
              : '';
          return `${p.id}\t${p.available ? 'available' : 'unavailable'}${detail}`;
        })
        .join('\n');
      return { result: ps, summary };
    },
  },

  'channel list': {
    describe: 'list channel surfaces and their honest readiness',
    async run(client) {
      const cs =
        await client.call<{ id: string; kind: string; status?: string; note?: string }[]>(
          'channels.list',
        );
      return {
        result: cs,
        summary: cs
          .map((c) => `${c.id}\t${c.status ?? c.kind}${c.note ? `\t${c.note}` : ''}`)
          .join('\n'),
      };
    },
  },
  'channel pair': {
    describe: 'create a pairing code linking a channel to a project',
    async run(client, { flags }) {
      const project = strFlag(flags, 'project');
      if (!project) {
        throw new CliError(
          'usage: amrita channel pair --project <ID_OR_SLUG> [--conversation ID] [--channel telegram]',
        );
      }
      const projectId = await resolveProjectId(client, project);
      const channel = strFlag(flags, 'channel') ?? 'telegram';
      const conversation = strFlag(flags, 'conversation');
      const r = await client.call<{ code: string }>('channels.pairing.create', {
        channel,
        projectId,
        ...(conversation ? { conversationId: conversation } : {}),
      });
      return { result: r, summary: `pairing code: ${r.code}  (channel ${channel})` };
    },
  },
  'channel pairings': {
    describe: 'list pairing codes',
    async run(client, { flags }) {
      const channel = strFlag(flags, 'channel');
      const ps = await client.call<{ code: string; channel: string; claimedBy: string | null }[]>(
        'channels.pairing.list',
        channel ? { channel } : {},
      );
      return {
        result: ps,
        summary: ps.length
          ? ps.map((p) => `${p.code}\t${p.channel}\t${p.claimedBy ?? '(unclaimed)'}`).join('\n')
          : '(no pairings)',
      };
    },
  },

  'lane list': {
    describe: 'list lanes (optionally by --project / --conversation / --status)',
    async run(client, { flags }) {
      const project = strFlag(flags, 'project');
      const conversation = strFlag(flags, 'conversation');
      const status = strFlag(flags, 'status');
      const params: Record<string, unknown> = {};
      if (project) params.projectId = await resolveProjectId(client, project);
      if (conversation) params.conversationId = conversation;
      if (status) params.status = status;
      const ls = await client.call<LaneLite[]>('lanes.list', params);
      return {
        result: ls,
        summary: ls.length
          ? ls.map((l) => `[${l.status}] ${l.kind} ${laneGoal(l)}  ${l.id}`).join('\n')
          : '(no lanes)',
      };
    },
  },
  'lane start': {
    describe: 'start a lane (--dry-run records the mandate; --real requires daemon opt-in)',
    async run(client, { flags }) {
      const goal = strFlag(flags, 'goal');
      if (!goal) {
        throw new CliError(
          'usage: amrita lane start --goal TEXT [--project ID_OR_SLUG] [--conversation ID] [--kind claude-code] [--dry-run] [--real]',
        );
      }
      const ctx = await resolveWriteContext(client, {
        project: strFlag(flags, 'project'),
        conversation: strFlag(flags, 'conversation'),
      });
      const kind = strFlag(flags, 'kind');
      const r = await client.call<LaneStartLite>('lanes.start', {
        conversationId: ctx.conversationId,
        goal,
        dryRun: flags['dry-run'] === true,
        real: flags.real === true,
        ...(kind ? { kind } : {}),
      });
      const meta = r.dryRun
        ? 'dry-run · mandate recorded'
        : r.error
          ? `aborted · ${r.error}`
          : r.report
            ? `exit ${r.report.exit}`
            : r.status;
      return { result: r, summary: `lane ${r.laneId} · ${r.status} · ${meta}` };
    },
  },
  'lane get': {
    describe: 'show a lane: status, mandate summary, and final report exit',
    async run(client, { positionals }) {
      const laneId = positionals[0];
      if (!laneId) throw new CliError('usage: amrita lane get <LANE_ID>');
      const lane = await client.call<LaneLite | null>('lanes.get', { laneId });
      if (!lane) throw new CliError(`lane not found: ${laneId}`, 'not_found');
      let exit = '';
      try {
        exit = lane.mergeJson
          ? `· exit ${(JSON.parse(lane.mergeJson) as { exit?: string }).exit}`
          : '';
      } catch {
        exit = '';
      }
      return {
        result: lane,
        summary: `lane ${lane.id} · ${lane.status} · ${lane.kind} ${laneGoal(lane)} ${exit}`.trim(),
      };
    },
  },
  'lane cancel': {
    describe: 'cancel a running lane',
    async run(client, { positionals }) {
      const laneId = positionals[0];
      if (!laneId) throw new CliError('usage: amrita lane cancel <LANE_ID>');
      const r = await client.call<LaneCancelLite>('lanes.cancel', { laneId });
      return {
        result: r,
        summary: r.cancelled
          ? `cancelled ${laneId} · status ${r.status ?? 'unknown'}`
          : `lane ${laneId} was not active (status ${r.status ?? 'unknown'})`,
      };
    },
  },
};

export const COMMAND_NAMES: readonly string[] = Object.keys(COMMANDS);
