/**
 * Secret-reference safety. Amrita stores only the *name* of an environment
 * variable that holds a secret (`accounts.secret_ref`), never the secret value,
 * and never in the event log. These helpers gate that name.
 */

/** The env-var NAME charset (mirrors the `accounts.secret_ref` SQL CHECK, ADR-0003). */
export const ENV_SECRET_REF_RE = /^[A-Z][A-Z0-9_]*$/;

/**
 * True if `name` is a safe env-var NAME to store as a secret *reference*:
 * UPPER_SNAKE_CASE, 3..64 chars, containing at least one underscore. The
 * underscore requirement rejects secret *values* that happen to be all-caps
 * alphanumeric (e.g. cloud access-key ids), so a real secret never passes. This
 * is intentionally stricter than the DB CHECK, which is the last line of defence.
 *
 * Never pass an actual secret value to this function — it validates a *name*.
 */
export function isSafeEnvSecretRefName(name: string): boolean {
  return (
    name.length >= 3 && name.length <= 64 && name.includes('_') && ENV_SECRET_REF_RE.test(name)
  );
}
