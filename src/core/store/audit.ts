import { getDb } from './db.ts';
import { now } from '../../shared/util.ts';

export type AuditKind =
  | 'tool-call'
  | 'connector-launch'
  | 'config-change'
  | 'permission'
  | 'update'
  | 'cron-run'
  | 'auth';

/** Append-only audit trail — the thing Hermes lacks. Never store secret values here. */
export function audit(
  kind: AuditKind,
  detail: Record<string, unknown>,
  scope: { sessionId?: string; projectSlug?: string | null } = {},
): void {
  getDb()
    .prepare(`INSERT INTO audit (at, kind, session_id, project_slug, detail) VALUES (?, ?, ?, ?, ?)`)
    .run(now(), kind, scope.sessionId ?? null, scope.projectSlug ?? null, JSON.stringify(detail));
}

export function recentAudit(limit = 50): { at: number; kind: string; detail: string }[] {
  return getDb()
    .prepare(`SELECT at, kind, detail FROM audit ORDER BY at DESC LIMIT ?`)
    .all(limit) as unknown as { at: number; kind: string; detail: string }[];
}
