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
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('probe timeout')), PROBE_TIMEOUT_MS),
      ),
    ]);
    if (res.ok) return 'ok';
    if (res.status === 401 || res.status === 403) return 'rejected';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Compute the live status of every registered connector. Reports carry env
 * NAMES only; the probe's token stays in its own scope and is never returned.
 */
export async function connectorStatuses(fetchImpl: FetchLike): Promise<ConnectorStatusReport[]> {
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
