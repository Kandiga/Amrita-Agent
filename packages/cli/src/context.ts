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
export function resolveProjectId(client: InProcessClient, slugOrId: string): string {
  const bySlug = client.call<ProjectRowLite | null>('project.get', { slug: slugOrId });
  if (bySlug) return bySlug.id;
  const byId = client.call<ProjectRowLite | null>('project.get', { id: slugOrId });
  if (byId) return byId.id;
  throw new CliError(`project not found: ${slugOrId}`, 'not_found');
}

function ensureSystemProjectId(client: InProcessClient): string {
  return client.call<ProjectRowLite>('project.ensure', { slug: SYSTEM_SLUG, name: 'System' }).id;
}

/**
 * Find-or-create the per-project "(default)" conversation — the sink the CLI uses
 * when a write command supplies no explicit conversation. Deterministic: it is
 * located by its sentinel title, so repeated commands reuse the same row.
 */
export function ensureDefaultConversation(client: InProcessClient, projectId: string): string {
  const convs = client.call<ConversationLite[]>('conversation.list', { projectId });
  const existing = convs.find((c) => c.title === DEFAULT_CONVERSATION_TITLE);
  if (existing) return existing.id;
  return client.call<ConversationLite>('conversation.create', {
    projectId,
    title: DEFAULT_CONVERSATION_TITLE,
  }).id;
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
export function resolveWriteContext(
  client: InProcessClient,
  opts: { project?: string | undefined; conversation?: string | undefined },
): WriteContext {
  if (opts.conversation) {
    const conv = client.call<ConversationLite | null>('conversation.get', {
      conversationId: opts.conversation,
    });
    if (!conv) throw new CliError(`conversation not found: ${opts.conversation}`, 'not_found');
    return { projectId: conv.projectId, conversationId: conv.id };
  }
  const projectId = opts.project
    ? resolveProjectId(client, opts.project)
    : ensureSystemProjectId(client);
  return { projectId, conversationId: ensureDefaultConversation(client, projectId) };
}
