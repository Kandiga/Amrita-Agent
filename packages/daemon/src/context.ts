import { type Dirent, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectFilesContext, ProjectGitContext } from '@amrita/protocol';
import { type CommandProber, defaultProber } from './runtimes.ts';

/**
 * Project context probes (ADR-0034): a read-only, bounded snapshot of a
 * project's working tree — git state via bounded no-shell spawns (the
 * runtimes.ts prober pattern), file summary via a capped readdir walk.
 * Paths and counts only; no writes; inconclusive probes yield honest nulls.
 */

const GIT_TIMEOUT_MS = 2_000;
const MAX_ENTRIES_VISITED = 2_000;
const MAX_TOP_DIRS = 40;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.pnpm-store', '.venv', '__pycache__']);

async function git(
  prober: CommandProber,
  root: string,
  args: string[],
): Promise<string | undefined> {
  const r = await prober('git', ['-C', root, ...args], GIT_TIMEOUT_MS);
  return r.kind === 'ok' ? r.stdout.trim() : undefined;
}

/** Probe git state at `root`. Never throws; omissions mean "could not verify". */
export async function probeGitContext(
  root: string,
  prober: CommandProber = defaultProber,
): Promise<ProjectGitContext> {
  const inside = await git(prober, root, ['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') return { isRepo: false };

  const out: ProjectGitContext = { isRepo: true };
  const branch = await git(prober, root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch) out.branch = branch;
  const porcelain = await git(prober, root, ['status', '--porcelain']);
  if (porcelain !== undefined) {
    out.dirtyCount = porcelain === '' ? 0 : porcelain.split('\n').length;
  }
  // "behind ahead" relative to the upstream; absent upstream → omitted.
  const counts = await git(prober, root, ['rev-list', '--left-right', '--count', '@{u}...HEAD']);
  if (counts) {
    const [behind, ahead] = counts.split(/\s+/).map((n) => Number.parseInt(n, 10));
    if (Number.isFinite(behind)) out.behind = behind as number;
    if (Number.isFinite(ahead)) out.ahead = ahead as number;
  }
  const last = await git(prober, root, ['log', '-1', '--format=%h %s']);
  if (last) out.lastCommit = last.slice(0, 120);
  return out;
}

/**
 * Summarize the file tree under `root`: top-level dirs with (bounded) recursive
 * file counts. Depth ≤ 2 below each top dir, ≤ MAX_ENTRIES_VISITED total.
 */
export function summarizeFiles(root: string): ProjectFilesContext {
  let visited = 0;
  let truncated = false;

  function countFiles(dir: string, depth: number): number {
    if (visited >= MAX_ENTRIES_VISITED) {
      truncated = true;
      return 0;
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    let files = 0;
    for (const e of entries) {
      if (visited >= MAX_ENTRIES_VISITED) {
        truncated = true;
        break;
      }
      visited++;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        if (depth < 2) files += countFiles(join(dir, e.name), depth + 1);
      } else if (e.isFile()) {
        files++;
      }
    }
    return files;
  }

  const topDirs: { name: string; files: number }[] = [];
  let rootFiles = 0;
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return { totalFiles: 0, truncated: false, topDirs: [] };
  }
  for (const e of entries) {
    visited++;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      if (topDirs.length < MAX_TOP_DIRS) {
        topDirs.push({ name: e.name, files: countFiles(join(root, e.name), 1) });
      } else {
        truncated = true;
      }
    } else if (e.isFile()) {
      rootFiles++;
    }
  }
  const totalFiles = rootFiles + topDirs.reduce((n, d) => n + d.files, 0);
  return { totalFiles, truncated, topDirs };
}

export function rootExists(root: string): boolean {
  return existsSync(root);
}
