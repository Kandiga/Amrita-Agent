import { CliError, type InProcessClient } from './client.ts';
import { ensureDefaultConversation, resolveProjectId, resolveWriteContext } from './context.ts';
import { strFlag } from './parse.ts';

export interface CommandCtx {
  positionals: string[];
  flags: Record<string, string | boolean>;
}
export interface Command {
  describe: string;
  run(client: InProcessClient, ctx: CommandCtx): { result: unknown; summary: string };
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
  available: boolean;
  requiresEnv: string | null;
  envPresent: boolean;
}
interface HealthLite {
  schemaVersion: number;
  dbPath: string;
  counts: { projects: number; conversations: number; messages: number; events: number };
}

export const COMMANDS: Record<string, Command> = {
  health: {
    describe: 'show daemon health and row counts',
    run(client) {
      const h = client.call<HealthLite>('health');
      const c = h.counts;
      return {
        result: h,
        summary:
          `amritad · schema v${h.schemaVersion} · ${h.dbPath}\n` +
          `projects ${c.projects} · conversations ${c.conversations} · messages ${c.messages} · events ${c.events}`,
      };
    },
  },

  'project ensure': {
    describe: 'create-or-get a project by slug',
    run(client, { positionals, flags }) {
      const slug = positionals[0];
      if (!slug) throw new CliError('usage: amrita project ensure <slug> [--name NAME]');
      const p = client.call<ProjectLite>('project.ensure', {
        slug,
        name: strFlag(flags, 'name') ?? slug,
      });
      return { result: p, summary: `project ${p.slug}  ${p.id}` };
    },
  },
  'project list': {
    describe: 'list projects',
    run(client) {
      const ps = client.call<ProjectLite[]>('project.list');
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
    run(client, { flags }) {
      const project = strFlag(flags, 'project');
      if (!project) throw new CliError('usage: amrita conversation create --project <ID_OR_SLUG>');
      const projectId = resolveProjectId(client, project);
      const title = strFlag(flags, 'title');
      const parent = strFlag(flags, 'parent');
      const c = client.call<ConvLite>('conversation.create', {
        projectId,
        ...(title ? { title } : {}),
        ...(parent ? { parentId: parent } : {}),
      });
      return { result: c, summary: `conversation ${c.id}` };
    },
  },
  'conversation tree': {
    describe: 'print a conversation and its descendants',
    run(client, { positionals }) {
      const id = positionals[0];
      if (!id) throw new CliError('usage: amrita conversation tree <CONVERSATION_ID>');
      const nodes = client.call<ConvLite[]>('conversation.tree', { conversationId: id });
      return {
        result: nodes,
        summary: nodes.map((n) => `${n.id}  ${n.title ?? '(untitled)'}`).join('\n') || '(empty)',
      };
    },
  },

  'message user': {
    describe: 'record a user message in a conversation',
    run(client, { positionals }) {
      const conversationId = positionals[0];
      const text = positionals.slice(1).join(' ');
      if (!conversationId || !text) {
        throw new CliError('usage: amrita message user <CONVERSATION_ID> <TEXT>');
      }
      const ctx = resolveWriteContext(client, { conversation: conversationId });
      const r = client.call<{ messageId: string; event: { seq: number } }>('message.user.record', {
        projectId: ctx.projectId,
        conversationId: ctx.conversationId,
        text,
        channel: 'cli',
      });
      return { result: r, summary: `recorded message ${r.messageId} (seq ${r.event.seq})` };
    },
  },

  'task create': {
    describe: 'create a task',
    run(client, { flags }) {
      const project = strFlag(flags, 'project');
      const title = strFlag(flags, 'title');
      if (!project || !title) {
        throw new CliError('usage: amrita task create --project <ID_OR_SLUG> --title TITLE');
      }
      const ctx = resolveWriteContext(client, {
        project,
        conversation: strFlag(flags, 'conversation'),
      });
      const r = client.call<{ taskId: string }>('tasks.create', {
        projectId: ctx.projectId,
        conversationId: ctx.conversationId,
        title,
      });
      return { result: r, summary: `task ${r.taskId}` };
    },
  },
  'task list': {
    describe: 'list tasks in a project',
    run(client, { flags }) {
      const project = strFlag(flags, 'project');
      if (!project) throw new CliError('usage: amrita task list --project <ID_OR_SLUG>');
      const ts = client.call<TaskLite[]>('tasks.list', {
        projectId: resolveProjectId(client, project),
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
    run(client, { positionals }) {
      const taskId = positionals[0];
      if (!taskId) throw new CliError('usage: amrita task complete <TASK_ID>');
      const task = client.call<TaskLite[]>('tasks.list', {}).find((t) => t.id === taskId);
      if (!task) throw new CliError(`task not found: ${taskId}`, 'not_found');
      const conversationId =
        task.conversationId ?? ensureDefaultConversation(client, task.projectId);
      client.call('tasks.complete', { projectId: task.projectId, conversationId, taskId });
      return { result: { ok: true, taskId }, summary: `completed ${taskId}` };
    },
  },

  'decision record': {
    describe: 'record a decision',
    run(client, { flags }) {
      const project = strFlag(flags, 'project');
      const text = strFlag(flags, 'text');
      if (!project || !text) {
        throw new CliError('usage: amrita decision record --project <ID_OR_SLUG> --text TEXT');
      }
      const ctx = resolveWriteContext(client, {
        project,
        conversation: strFlag(flags, 'conversation'),
      });
      const r = client.call<{ decisionId: string }>('decisions.record', {
        projectId: ctx.projectId,
        conversationId: ctx.conversationId,
        text,
      });
      return { result: r, summary: `decision ${r.decisionId}` };
    },
  },

  'memory put': {
    describe: 'store a memory entry',
    run(client, { flags }) {
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
      const ctx = resolveWriteContext(client, project ? { project } : {});
      const r = client.call<{ entryId: string }>('memory.put', {
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
    run(client, { positionals, flags }) {
      const query = positionals.join(' ');
      if (!query) throw new CliError('usage: amrita memory search <QUERY>');
      const scope = strFlag(flags, 'scope');
      const project = strFlag(flags, 'project');
      const ms = client.call<MemLite[]>('memory.search', {
        query,
        ...(scope ? { scope } : {}),
        ...(project ? { projectId: resolveProjectId(client, project) } : {}),
      });
      return {
        result: ms,
        summary: ms.length ? ms.map((m) => `${m.content}  (${m.id})`).join('\n') : '(no matches)',
      };
    },
  },

  'account connect': {
    describe: 'register a provider account (no secret value)',
    run(client, { flags }) {
      const provider = strFlag(flags, 'provider');
      if (!provider)
        throw new CliError('usage: amrita account connect --provider PROVIDER [--label LABEL]');
      const label = strFlag(flags, 'label');
      const authMode = strFlag(flags, 'auth-mode') ?? 'api_key';
      const ctx = resolveWriteContext(client, {});
      const r = client.call<{ accountId: string }>('accounts.connect', {
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
    run(client, { positionals }) {
      const accountId = positionals[0];
      const envName = positionals[1];
      if (!accountId || !envName) {
        throw new CliError('usage: amrita account bind-secret <ACCOUNT_ID> <ENV_NAME>');
      }
      client.call('accounts.bindSecretRef', { accountId, envName });
      return {
        result: { ok: true, accountId, secretRef: envName },
        summary: `bound ${accountId} → ${envName}`,
      };
    },
  },
  'account status': {
    describe: 'show provider config status',
    run(client, { positionals }) {
      const accountId = positionals[0];
      if (!accountId) throw new CliError('usage: amrita account status <ACCOUNT_ID>');
      const r = client.call<{ status: string | null }>('accounts.configStatus', { accountId });
      return { result: r, summary: `status: ${r.status ?? 'unknown'}` };
    },
  },

  chat: {
    describe: 'run a chat turn (mock provider by default)',
    run(client, { positionals, flags }) {
      const text = positionals.join(' ');
      if (!text) {
        throw new CliError(
          'usage: amrita chat <TEXT> [--project ID_OR_SLUG] [--conversation ID] [--provider mock] [--model MODEL]',
        );
      }
      const ctx = resolveWriteContext(client, {
        project: strFlag(flags, 'project'),
        conversation: strFlag(flags, 'conversation'),
      });
      const provider = strFlag(flags, 'provider');
      const model = strFlag(flags, 'model');
      const turn = client.call<ChatTurnLite>('chat.turn', {
        conversationId: ctx.conversationId,
        text,
        channel: 'cli',
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
      });
      const u = turn.usage;
      const meta = `(${turn.provider} · ${turn.model}${u ? ` · ${u.inputTokens}/${u.outputTokens} tok` : ''})`;
      return { result: turn, summary: `${turn.text ?? '(no reply)'}\n${meta}` };
    },
  },

  'provider list': {
    describe: 'list chat providers and availability',
    run(client) {
      const ps = client.call<ProviderInfoLite[]>('providers.list');
      const summary = ps
        .map((p) => {
          const env = p.requiresEnv
            ? ` (needs ${p.requiresEnv}: ${p.envPresent ? 'present' : 'missing'})`
            : '';
          return `${p.id}\t${p.available ? 'available' : 'unavailable'}${env}`;
        })
        .join('\n');
      return { result: ps, summary };
    },
  },
};

export const COMMAND_NAMES: readonly string[] = Object.keys(COMMANDS);
