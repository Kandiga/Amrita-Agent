/**
 * Community onboarding (P5) — the ONE-command open lifecycle, pure core.
 *
 * Owns the decisions (URL, readiness polling, port choice, token handoff) so the
 * process-spawning shell in `commands.ts` stays thin and the logic is testable
 * without spawning anything. The daemon + web are two local processes; this makes
 * `amrita open` start whatever is down, wait for readiness, and hand the browser
 * a one-time #token= so no bearer is ever hand-copied (finding 4).
 */

export const DEFAULT_DAEMON_PORT = 7460;
export const DEFAULT_WEB_PORT = 7461;

export interface OpenPlan {
  daemonPort: number;
  webPort: number;
  daemonHealthUrl: string;
  webHealthUrl: string;
}

export function planOpen(opts: { daemonPort?: number; webPort?: number } = {}): OpenPlan {
  const daemonPort = opts.daemonPort ?? DEFAULT_DAEMON_PORT;
  const webPort = opts.webPort ?? DEFAULT_WEB_PORT;
  return {
    daemonPort,
    webPort,
    daemonHealthUrl: `http://127.0.0.1:${daemonPort}/health`,
    webHealthUrl: `http://127.0.0.1:${webPort}/health`,
  };
}

/** The URL to print/open. A token becomes a one-time #token= the SPA adopts then strips. */
export function openUrl(webPort: number, token?: string): string {
  const base = `http://localhost:${webPort}/`;
  return token ? `${base}#token=${encodeURIComponent(token)}` : base;
}

/**
 * Poll `probe` until it resolves true or the budget is exhausted. Returns whether
 * readiness was reached and how many attempts it took. `sleep` is injected so the
 * loop is deterministic in tests.
 */
export async function waitForReady(
  probe: () => Promise<boolean>,
  opts: { tries?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ ready: boolean; attempts: number }> {
  const tries = opts.tries ?? 40;
  const delayMs = opts.delayMs ?? 250;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; attempt <= tries; attempt++) {
    if (await probe()) return { ready: true, attempts: attempt };
    if (attempt < tries) await sleep(delayMs);
  }
  return { ready: false, attempts: tries };
}

/** Choose the platform open command; null when headless (print the URL instead). */
export function platformOpenCommand(
  platform: NodeJS.Platform,
): { cmd: string; args: string[] } | null {
  if (platform === 'darwin') return { cmd: 'open', args: [] };
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', ''] };
  if (platform === 'linux') return { cmd: 'xdg-open', args: [] };
  return null; // unknown/headless — the caller prints the URL, never claims it opened
}
