/**
 * Deny-by-default environment scrubbing for lane child processes.
 *
 * A lane runs untrusted-ish work in a child process; it must NEVER inherit the
 * daemon's secrets. The scrub is an **allowlist**: only a short list of benign
 * variables (plus an explicit caller allowlist) is forwarded, and every name is
 * additionally checked against a forbidden-pattern list. That second guard means
 * a secret-shaped name can never be forwarded — `ANTHROPIC_API_KEY`,
 * `OPENAI_API_KEY`, `GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY`, SSH agent sockets,
 * passwords, etc. are dropped even if a caller mistakenly allowlists them.
 *
 * In particular: a Claude Code lane authenticates via its own subscription
 * login, so the daemon never forwards `ANTHROPIC_API_KEY` into it (ADR-0014).
 */

/** The only variables forwarded by default — all benign, none secret-shaped. */
export const DEFAULT_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
  'SHELL',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'PWD',
];

/** Names matching any of these are NEVER forwarded, even if allowlisted. */
const FORBIDDEN_ENV_PATTERNS: readonly RegExp[] = [
  /key/i,
  /secret/i,
  /token/i,
  /password/i,
  /passwd/i,
  /credential/i,
  /auth/i,
  /session/i,
  /cookie/i,
  /private/i,
  /^aws_/i,
  /^gcp_/i,
  /^azure_/i,
  /^anthropic/i,
  /^openai/i,
  /ssh/i,
  /gpg/i,
  /^github/i,
  /^gh_/i,
  /^npm_/i,
];

/** True if a name looks secret-bearing and must never reach a child process. */
export function isForbiddenEnvName(name: string): boolean {
  return FORBIDDEN_ENV_PATTERNS.some((re) => re.test(name));
}

/**
 * Build a scrubbed child environment from `baseEnv`. Only names in the default
 * allowlist plus `allowlist` are considered, and any forbidden (secret-shaped)
 * name is dropped regardless. Absent/empty values are skipped.
 */
export function scrubEnv(
  baseEnv: Record<string, string | undefined> = process.env,
  allowlist: readonly string[] = [],
): Record<string, string> {
  const allow = new Set<string>([...DEFAULT_ENV_ALLOWLIST, ...allowlist]);
  const out: Record<string, string> = {};
  for (const name of allow) {
    if (isForbiddenEnvName(name)) continue; // belt-and-suspenders: never a secret
    const value = baseEnv[name];
    if (typeof value === 'string' && value.length > 0) out[name] = value;
  }
  return out;
}
