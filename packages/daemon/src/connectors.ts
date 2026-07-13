import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type ConnectorManifest,
  type ConnectorStatusReport,
  connectorManifestSchema,
} from '@amrita/protocol';
import { type FetchLike, envPresent } from './provider.ts';

/**
 * Code-registered connector manifests + the honest status probe (ADR-0022).
 * Channels (web/telegram) stay out of this registry — their truth lives in
 * `channels.list`. `connected` here is only ever the result of a live probe
 * through the kernel's injected fetch; doctor stays presence-only.
 */

const RAW_MANIFESTS: ConnectorManifest[] = [
  {
    slug: 'github',
    kind: 'source',
    title: 'GitHub',
    description:
      'One-way import of repository issues into Amrita tasks with provenance (github:owner/repo#N). Never writes to GitHub.',
    capabilities: ['issues.import'],
    requiredEnv: ['GITHUB_TOKEN'],
    setupCommands: [
      'export GITHUB_TOKEN=<fine-grained token with repo issues read>  # Amrita stores the NAME only, never the value',
    ],
    docsUrl: 'https://docs.github.com/en/rest/issues/issues',
  },
  {
    slug: 'claude-mcp',
    kind: 'tool',
    title: 'MCP servers (Claude Code CLI)',
    description:
      "MCP servers configured for the local `claude` CLI. Read-only visibility: Amrita reads the CLI's config and reports what is configured — it never claims a server is healthy without a live probe.",
    capabilities: ['mcp.visibility'],
    requiredEnv: [],
    setupCommands: ['claude mcp add <name> <command-or-url>', 'claude mcp list  # live health'],
  },
  {
    slug: 'codex-mcp',
    kind: 'tool',
    title: 'MCP servers (Codex CLI)',
    description:
      'MCP servers configured for the local `codex` CLI (config.toml). Read-only visibility — configuration state only, health via `codex mcp list`.',
    capabilities: ['mcp.visibility'],
    requiredEnv: [],
    setupCommands: ['codex mcp add <name> -- <command>', 'codex mcp list  # live health'],
  },
];

/** Parsed at module load — an invalid manifest is a boot error, not a runtime surprise. */
export const CONNECTOR_MANIFESTS: readonly ConnectorManifest[] = RAW_MANIFESTS.map((m) =>
  connectorManifestSchema.parse(m),
);

const PROBE_TIMEOUT_MS = 3000;

/** GitHub auth probe: GET /rate_limit is cheap, scope-free, and 401s on a bad token. */
async function probeGithub(fetchImpl: FetchLike): Promise<'ok' | 'rejected' | 'unknown'> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return 'unknown';
  // The race subscribes to the timeout promise, so a late rejection is never
  // "unhandled" — but the timer must still be cleared or it keeps the event
  // loop alive for the full window after a fast probe.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const res = await Promise.race([
      fetchImpl('https://api.github.com/rate_limit', {
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'amrita-daemon',
        },
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('probe timeout')), PROBE_TIMEOUT_MS);
      }),
    ]);
    if (res.ok) return 'ok';
    if (res.status === 401 || res.status === 403) return 'rejected';
    return 'unknown';
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timer);
  }
}

/** Injectable config reader so MCP visibility is testable without a real home dir. */
export interface McpConfigIo {
  readFile?: (path: string) => string | null;
  homeDir?: string;
}

function defaultReadFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Count MCP servers in the claude CLI config (`~/.claude.json` mcpServers). */
export function claudeMcpServerNames(io: McpConfigIo = {}): string[] | null {
  const read = io.readFile ?? defaultReadFile;
  const raw = read(join(io.homeDir ?? homedir(), '.claude.json'));
  if (raw === null) return null;
  try {
    const cfg = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    return Object.keys(cfg.mcpServers ?? {});
  } catch {
    return null;
  }
}

/** Count MCP servers in the codex CLI config (`~/.codex/config.toml` [mcp_servers.*]). */
export function codexMcpServerNames(io: McpConfigIo = {}): string[] | null {
  const read = io.readFile ?? defaultReadFile;
  const raw = read(join(io.homeDir ?? homedir(), '.codex', 'config.toml'));
  if (raw === null) return null;
  const names: string[] = [];
  for (const m of raw.matchAll(/^\s*\[mcp_servers\.([^\]"]+)\]/gm)) {
    if (m[1]) names.push(m[1]);
  }
  return names;
}

function mcpReport(manifest: ConnectorManifest, names: string[] | null): ConnectorStatusReport {
  if (names === null) {
    return {
      manifest,
      state: 'needs_setup',
      detail: 'no CLI config found — is the CLI installed and initialized?',
      missingEnv: [],
      nextCommand: manifest.setupCommands[0] ?? '',
    };
  }
  if (names.length === 0) {
    return {
      manifest,
      state: 'needs_setup',
      detail: 'no MCP servers configured yet',
      missingEnv: [],
      nextCommand: manifest.setupCommands[0] ?? '',
    };
  }
  const shown = names.slice(0, 8).join(', ');
  return {
    manifest,
    state: 'status_unknown', // configured ≠ healthy: connected needs a live probe
    detail: `${names.length} configured: ${shown}${names.length > 8 ? ', …' : ''} (config read only — health via \`${manifest.slug === 'claude-mcp' ? 'claude' : 'codex'} mcp list\`)`,
    missingEnv: [],
    nextCommand: manifest.setupCommands[1] ?? '',
  };
}

/**
 * Compute the live status of every registered connector. Reports carry env
 * NAMES only; the probe's token stays in its own scope and is never returned.
 */
export async function connectorStatuses(
  fetchImpl: FetchLike,
  mcpIo: McpConfigIo = {},
): Promise<ConnectorStatusReport[]> {
  const reports: ConnectorStatusReport[] = [];
  for (const manifest of CONNECTOR_MANIFESTS) {
    const missingEnv = manifest.requiredEnv.filter((name) => !envPresent(name));
    if (missingEnv.length > 0) {
      reports.push({
        manifest,
        state: 'needs_setup',
        detail: `needs setup — missing env: ${missingEnv.join(', ')} (presence-checked only)`,
        missingEnv,
        nextCommand: manifest.setupCommands[0] ?? '',
      });
      continue;
    }
    if (manifest.slug === 'claude-mcp') {
      reports.push(mcpReport(manifest, claudeMcpServerNames(mcpIo)));
      continue;
    }
    if (manifest.slug === 'codex-mcp') {
      reports.push(mcpReport(manifest, codexMcpServerNames(mcpIo)));
      continue;
    }
    if (manifest.slug === 'github') {
      const probe = await probeGithub(fetchImpl);
      reports.push({
        manifest,
        state:
          probe === 'ok'
            ? 'connected'
            : probe === 'rejected'
              ? 'configured_but_failing'
              : 'status_unknown',
        detail:
          probe === 'ok'
            ? 'token verified against api.github.com (live probe)'
            : probe === 'rejected'
              ? 'GITHUB_TOKEN is set but api.github.com rejected it — token invalid, expired, or lacking access'
              : 'GITHUB_TOKEN is set but the live probe was inconclusive (network/timeout) — not claiming connected',
        missingEnv: [],
        ...(probe === 'rejected' ? { nextCommand: manifest.setupCommands[0] ?? '' } : {}),
      });
      continue;
    }
    // A registered connector without a probe: configured is all we can honestly say.
    reports.push({
      manifest,
      state: 'status_unknown',
      detail: 'required env present (presence-checked only) — no live probe implemented yet',
      missingEnv: [],
    });
  }
  return reports;
}
