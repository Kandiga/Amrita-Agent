import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../../shared/paths.ts';
import { isoDate } from '../../shared/util.ts';

/**
 * Per-project markdown vault (Obsidian-compatible).
 * BRIEF.md      — what the project is
 * CONTEXT.md    — curated context pack, loaded every session
 * DECISIONS.md  — append-only decision log
 * TASKS.md      — current state / next steps
 * sessions/     — auto-generated session summaries
 */

const VAULT_FILES = ['BRIEF.md', 'CONTEXT.md', 'DECISIONS.md', 'TASKS.md'] as const;
export type VaultFile = (typeof VAULT_FILES)[number];

function frontmatter(type: string): string {
  const d = isoDate();
  return `---\ntype: ${type}\ncreated: ${d}\nupdated: ${d}\n---\n\n`;
}

export function scaffoldVault(slug: string, name: string): void {
  const vault = paths.vault(slug);
  mkdirSync(join(vault, 'sessions'), { recursive: true });
  const templates: Record<VaultFile, string> = {
    'BRIEF.md': `${frontmatter('project')}# ${name}\n\n_What this project is, for whom, and what done looks like._\n\n## Goal\n\n(to be filled — tell Amrita about this project)\n\n## Constraints\n\n- \n`,
    'CONTEXT.md': `${frontmatter('context')}# Context Pack — ${name}\n\n_Curated facts every session should know. Keep this small and current._\n\n- Project created ${isoDate()}.\n`,
    'DECISIONS.md': `${frontmatter('decisions')}# Decision Log — ${name}\n\n_Append-only. Newest last._\n`,
    'TASKS.md': `${frontmatter('tasks')}# Tasks — ${name}\n\n## Now\n\n- [ ] Define the project brief\n\n## Later\n\n## Done\n`,
  };
  for (const [file, content] of Object.entries(templates)) {
    const full = join(vault, file);
    if (!existsSync(full)) writeFileSync(full, content, 'utf8');
  }
}

export function readVaultFile(slug: string, file: VaultFile): string {
  const full = join(paths.vault(slug), file);
  return existsSync(full) ? readFileSync(full, 'utf8') : '';
}

export function writeVaultFile(slug: string, file: VaultFile, content: string): void {
  mkdirSync(paths.vault(slug), { recursive: true });
  writeFileSync(join(paths.vault(slug), file), content, 'utf8');
}

export function appendDecision(slug: string, decision: string): void {
  const full = join(paths.vault(slug), 'DECISIONS.md');
  appendFileSync(full, `\n## ${isoDate()}\n\n${decision.trim()}\n`, 'utf8');
}

export function writeSessionSummary(slug: string, sessionId: string, summary: string): string {
  const dir = join(paths.vault(slug), 'sessions');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${isoDate()}-${sessionId.slice(-8)}.md`);
  writeFileSync(file, `${frontmatter('session-summary')}${summary.trim()}\n`, 'utf8');
  return file;
}

export function recentSessionSummaries(slug: string, count = 3): string[] {
  const dir = join(paths.vault(slug), 'sessions');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .slice(-count)
    .map((f) => readFileSync(join(dir, f), 'utf8'));
}

// ---------- Global user memory ----------

export function readUserMemory(): string {
  const file = paths.userMemory();
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

export function appendUserMemory(fact: string): void {
  const file = paths.userMemory();
  if (!existsSync(file)) {
    writeFileSync(file, `${frontmatter('user-memory')}# About the user\n`, 'utf8');
  }
  appendFileSync(file, `\n- ${fact.trim()} _(noted ${isoDate()})_\n`, 'utf8');
}
