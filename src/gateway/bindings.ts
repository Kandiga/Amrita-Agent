import { getDb } from '../core/store/db.ts';
import type { Binding } from '../shared/types.ts';
import { createSession, getSession } from '../core/store/sessions.ts';
import { now } from '../shared/util.ts';

interface BindingRow {
  channel: string;
  chat_id: string;
  project_slug: string | null;
  session_id: string;
  updated_at: number;
}

/** Resolve (channel, chatId) → binding, creating a main-Amrita binding on first contact. */
export function resolveBinding(channel: string, chatId: string): Binding {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM bindings WHERE channel = ? AND chat_id = ?`)
    .get(channel, chatId) as BindingRow | undefined;
  if (row) {
    // Heal dangling session references.
    if (getSession(row.session_id)) {
      return {
        channel: row.channel,
        chatId: row.chat_id,
        projectSlug: row.project_slug,
        sessionId: row.session_id,
        updatedAt: row.updated_at,
      };
    }
  }
  const session = createSession(row?.project_slug ?? null, channel);
  const binding: Binding = {
    channel,
    chatId,
    projectSlug: row?.project_slug ?? null,
    sessionId: session.id,
    updatedAt: now(),
  };
  saveBinding(binding);
  return binding;
}

export function saveBinding(binding: Binding): void {
  getDb()
    .prepare(
      `INSERT INTO bindings (channel, chat_id, project_slug, session_id, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(channel, chat_id) DO UPDATE SET
         project_slug = excluded.project_slug,
         session_id = excluded.session_id,
         updated_at = excluded.updated_at`,
    )
    .run(binding.channel, binding.chatId, binding.projectSlug, binding.sessionId, now());
}

/** Switch a chat to a project (or back to main with null); starts a fresh session. */
export function switchContext(
  channel: string,
  chatId: string,
  projectSlug: string | null,
): Binding {
  const session = createSession(projectSlug, channel);
  const binding: Binding = {
    channel,
    chatId,
    projectSlug,
    sessionId: session.id,
    updatedAt: now(),
  };
  saveBinding(binding);
  return binding;
}

/** Fresh session in the current context. */
export function resetSession(channel: string, chatId: string): Binding {
  const current = resolveBinding(channel, chatId);
  return switchContext(channel, chatId, current.projectSlug);
}
