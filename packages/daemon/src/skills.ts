import { type Dirent, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  type SkillManifest,
  type SkillStatus,
  type SkillTier,
  skillManifestSchema,
} from '@amrita/protocol';
import { amritaHome } from './home.ts';

/**
 * The skill registry (ADR-0035): registers and gates, never executes.
 * Registry entry + permissions + docs are schema-mandatory — a directory
 * without a valid `skill.json` is `unregistered`/`invalid` and never loadable.
 *
 * Tiers: `system` (code-registered below), `shared` (~/.amrita/skills/<name>),
 * `project` (<project root>/.amrita/skills/<name>).
 */

/**
 * System skills describe capabilities that ALREADY exist as RPC verbs — the
 * registry ships with real content and zero pretense (no executor exists yet).
 */
export const SYSTEM_SKILLS: SkillManifest[] = [
  {
    name: 'brain-capture',
    tier: 'system',
    version: '1.0.0',
    description: 'Capture a structured fact into the Project Brain (harness.capture).',
    owner: 'amrita',
    permissions: { toolsets: ['harness.capture'] },
    usage:
      'Use `amrita` chat or the Brain panel capture box; the fact lands as a normalized knowledge record with provenance (ADR-0027).',
  },
  {
    name: 'github-issues-import',
    tier: 'system',
    version: '1.0.0',
    description: 'One-way import of GitHub issues into project tasks (github.importIssues).',
    owner: 'amrita',
    permissions: { toolsets: ['github.importIssues'] },
    usage:
      'Run `amrita github import --project <p> --repo owner/repo` (needs GITHUB_TOKEN, name only in store). Idempotent by externalRef; Amrita never writes to GitHub (ADR-0022).',
  },
  {
    name: 'conversation-compress',
    tier: 'system',
    version: '1.0.0',
    description: 'Compress a long conversation into a lineage child with a digest (ADR-0033).',
    owner: 'amrita',
    permissions: { toolsets: ['conversation.compress'] },
    usage:
      'Run `amrita compress <conversationId>`; the parent is archived and the child starts with a deterministic digest system message. The event log stays replayable.',
  },
];

/** Value-free zod-issue projection (paths only — never received values). */
function issuePaths(issues: { path: PropertyKey[] }[]): string {
  const paths = issues.map((i) => i.path.join('.') || '(root)');
  return [...new Set(paths)].slice(0, 6).join(', ');
}

function scanTier(dir: string, tier: SkillTier): SkillStatus[] {
  if (!existsSync(dir)) return [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const rows: SkillStatus[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const source = join(dir, e.name);
    const manifestPath = join(source, 'skill.json');
    if (!existsSync(manifestPath)) {
      rows.push({
        name: e.name,
        tier,
        source,
        state: 'unregistered',
        detail: 'no skill.json manifest — a skill without a registry entry cannot load (ADR-0035)',
      });
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      rows.push({
        name: e.name,
        tier,
        source,
        state: 'invalid',
        detail: 'skill.json is not valid JSON',
      });
      continue;
    }
    const parsed = skillManifestSchema.safeParse(raw);
    if (!parsed.success) {
      rows.push({
        name: e.name,
        tier,
        source,
        state: 'invalid',
        detail: `manifest rejected (fields: ${issuePaths(parsed.error.issues)}) — registry entry, permissions, and usage docs are mandatory`,
      });
      continue;
    }
    if (parsed.data.tier !== tier) {
      rows.push({
        name: parsed.data.name,
        tier,
        source,
        state: 'invalid',
        detail: `manifest declares tier '${parsed.data.tier}' but lives in the ${tier} directory`,
      });
      continue;
    }
    rows.push({
      name: parsed.data.name,
      tier,
      source,
      state: 'active',
      detail: 'registered and loadable (no skill executor exists yet — honest registry only)',
      manifest: parsed.data,
    });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export interface SkillScanOptions {
  /** The project root for project-tier skills; absent = tier skipped. */
  projectRoot?: string;
  /** Override the amrita home (tests). */
  homeDir?: string;
}

/** Full registry scan: system (builtin) + shared (~/.amrita) + project tiers. */
export function loadSkillStatuses(opts: SkillScanOptions = {}): SkillStatus[] {
  const system: SkillStatus[] = SYSTEM_SKILLS.map((m) => ({
    name: m.name,
    tier: 'system',
    source: 'builtin',
    state: 'active',
    detail: 'shipped with Amrita (code-registered; not user-editable)',
    manifest: skillManifestSchema.parse(m), // self-validating: a bad builtin fails loudly
  }));
  const home = opts.homeDir ?? amritaHome();
  const shared = scanTier(join(home, 'skills'), 'shared');
  const project = opts.projectRoot
    ? scanTier(join(opts.projectRoot, '.amrita', 'skills'), 'project')
    : [];
  return [...system, ...shared, ...project];
}
