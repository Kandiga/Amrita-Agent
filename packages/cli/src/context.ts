import { CliError, type InProcessClient } from './client.ts';

interface ProjectRowLite {
  id: string;
  slug: string;
}
interface ConversationLite {
  id: string;
  projectId: string;
  title: string | null;
}

const SYSTEM_SLUG = 'system';
const DEFAULT_CONVERSATION_TITLE = '(default)';

/** Resolve a project by slug first, then by id; throw if neither matches. */
export async function resolveProjectId(client: InProcessClient, slugOrId: string): Promise<string> {
  const bySlug = await client.call<ProjectRowLite | null>('project.get', { slug: slugOrId });
  if (bySlug) return bySlug.id;
  const byId = await client.call<ProjectRowLite | null>('project.get', { id: slugOrId });
  if (byId) return byId.id;
  throw new CliError(`project not found: ${slugOrId}`, 'not_found');
}

async function ensureSystemProjectId(client: InProcessClient): Promise<string> {
  const p = await client.call<ProjectRowLite>('project.ensure', {
    slug: SYSTEM_SLUG,
    name: 'System',
  });
  return p.id;
}

/**
 * Find-or-create the per-project "(default)" conversation — the sink the CLI uses
 * when a write command supplies no explicit conversation. Deterministic: it is
 * located by its sentinel title, so repeated commands reuse the same row.
 */
export async function ensureDefaultConversation(
  client: InProcessClient,
  projectId: string,
): Promise<string> {
  const convs = await client.call<ConversationLite[]>('conversation.list', { projectId });
  const existing = convs.find((c) => c.title === DEFAULT_CONVERSATION_TITLE);
  if (existing) return existing.id;
  const created = await client.call<ConversationLite>('conversation.create', {
    projectId,
    title: DEFAULT_CONVERSATION_TITLE,
  });
  return created.id;
}

export interface WriteContext {
  projectId: string;
  conversationId: string;
}

/**
 * Resolve the (projectId, conversationId) envelope every write needs:
 * - explicit `conversation` → use it and derive its project;
 * - else `project` → that project's default conversation;
 * - else → the system project's default conversation.
 */
export async function resolveWriteContext(
  client: InProcessClient,
  opts: { project?: string | undefined; conversation?: string | undefined },
): Promise<WriteContext> {
  if (opts.conversation) {
    const conv = await client.call<ConversationLite | null>('conversation.get', {
      conversationId: opts.conversation,
    });
    if (!conv) throw new CliError(`conversation not found: ${opts.conversation}`, 'not_found');
    return { projectId: conv.projectId, conversationId: conv.id };
  }
  const projectId = opts.project
    ? await resolveProjectId(client, opts.project)
    : await ensureSystemProjectId(client);
  return { projectId, conversationId: await ensureDefaultConversation(client, projectId) };
}
