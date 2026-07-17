import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  amritaHome,
  generateDevToken,
  parseEnvFile,
  secretsEnvPath,
  writeSecretsEnv,
} from '@amrita/daemon';
import {
  DEFAULT_DAEMON_PORT,
  DEFAULT_WEB_PORT,
  openUrl,
  planOpen,
  platformOpenCommand,
  waitForReady,
} from './lifecycle.ts';
import type { IO } from './run.ts';

/**
 * `amrita open` (P5) — the ONE lifecycle command. Runs BEFORE any in-process
 * kernel opens (a launcher, not an RPC op): it starts whatever local component
 * is down (daemon + web), waits for readiness, and prints/opens one PLAIN URL.
 * Auth is a typed single-use pairing code → HttpOnly cookie session (ADR-0057);
 * the bearer never leaves the server side. Honest by construction: it never
 * claims the UI opened on a headless host, and refuses clearly when the web
 * build is missing rather than serving a 404.
 */

function healthOk(url: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpGet(url, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** A stable control-surface token, persisted so it survives restarts and the
 *  browser handoff. Generated once if the operator hasn't set one. Never logged. */
function resolveStableToken(io: IO): string {
  const env = process.env;
  if (typeof env.AMRITA_AUTH_TOKEN === 'string' && env.AMRITA_AUTH_TOKEN.length > 0) {
    return env.AMRITA_AUTH_TOKEN;
  }
  const path = secretsEnvPath(env);
  if (existsSync(path)) {
    const existing = parseEnvFile(readFileSync(path, 'utf8')).AMRITA_AUTH_TOKEN;
    if (existing && existing.length > 0) return existing;
  }
  // Credential material: CSPRNG only (the daemon's 192-bit token authority),
  // never a seeded PRNG — this bearer gates the whole control surface.
  const token = generateDevToken();
  writeSecretsEnv({ AMRITA_AUTH_TOKEN: token }, env);
  process.env.AMRITA_AUTH_TOKEN = token;
  io.out(`  generated a stable control token → ${path} (0600)`);
  return token;
}

/** ADR-0057: ask the daemon for a single-use browser pairing code (bearer RPC). */
async function mintPairingCode(daemonPort: number, bearer: string): Promise<string | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${daemonPort}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ id: 1, method: 'auth.pair.mint' }),
    });
    if (!r.ok) return null;
    const body = (await r.json()) as { result?: { code?: unknown } };
    const code = body.result?.code;
    return typeof code === 'string' && code.length > 0 ? code : null;
  } catch {
    return null;
  }
}

function serveWebScript(): string | null {
  // Installed layout: <home>/deploy/serve-web.mjs; dev layout: repo/deploy/serve-web.mjs.
  const candidates = [
    join(amritaHome(), '..', 'deploy', 'serve-web.mjs'),
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'deploy', 'serve-web.mjs'),
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

export async function runLauncher(
  name: string,
  flags: Record<string, unknown>,
  io: IO,
): Promise<number> {
  if (name !== 'open') return -1; // not a launcher command → fall through to RPC dispatch
  const daemonPort = Number(flags['daemon-port'] ?? DEFAULT_DAEMON_PORT);
  const webPort = Number(flags['web-port'] ?? DEFAULT_WEB_PORT);
  const plan = planOpen({ daemonPort, webPort });
  const token = resolveStableToken(io);
  // ADR-0057 finding 1: declare the dashboard origin(s) so the daemon honors the
  // cookie ONLY for requests from THIS web port. Preserve any operator-set value.
  const webOrigins =
    process.env.AMRITA_WEB_ORIGINS ?? `http://localhost:${webPort},http://127.0.0.1:${webPort}`;
  const spawned: ChildProcess[] = [];

  // 1) daemon
  if (!(await healthOk(plan.daemonHealthUrl))) {
    io.out('  starting the daemon…');
    const child = spawn('amritad', ['--http', '--port', String(daemonPort)], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, AMRITA_AUTH_TOKEN: token, AMRITA_WEB_ORIGINS: webOrigins },
    });
    child.on('error', () =>
      io.err('  ! could not launch `amritad` — is Amrita installed and on PATH?'),
    );
    child.unref();
    spawned.push(child);
    const r = await waitForReady(() => healthOk(plan.daemonHealthUrl));
    if (!r.ready) {
      io.err('  ! the daemon did not become ready — run `amrita doctor` for details');
      return 1;
    }
  }
  io.out('  ✓ daemon ready');

  // 2) web
  if (!(await healthOk(plan.webHealthUrl))) {
    const script = serveWebScript();
    if (!script) {
      io.err('  ! web server not found (deploy/serve-web.mjs). Reinstall or run from the repo.');
      return 1;
    }
    io.out('  starting the web UI…');
    const child = spawn(
      process.execPath,
      [script, '--port', String(webPort), '--daemon', `127.0.0.1:${daemonPort}`],
      {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env },
      },
    );
    child.on('error', () => io.err('  ! could not launch the web server'));
    child.unref();
    spawned.push(child);
    const r = await waitForReady(() => healthOk(plan.webHealthUrl));
    if (!r.ready) {
      io.err(
        '  ! the web UI did not become ready — the build may be missing (pnpm --dir apps/web build)',
      );
      return 1;
    }
  }
  io.out('  ✓ web UI ready');

  // 3) ADR-0057: mint a single-use pairing code (bearer-gated RPC) and print it
  // for the user to TYPE into the UI. The bearer itself never reaches the
  // browser — no URL fragment, no localStorage, no URL secret.
  const pairing = await mintPairingCode(daemonPort, token);
  const url = openUrl(webPort);
  io.out('');
  io.out(`  Amrita is open at:  ${url}`);
  if (pairing) {
    io.out(`  Pairing code (if the dashboard asks): ${pairing} — single use, 2 minutes`);
  } else {
    io.err('  ! could not mint a pairing code — run `amrita open` again if the UI asks for one');
  }
  const opener = platformOpenCommand(process.platform);
  if (opener) {
    try {
      const c = spawn(opener.cmd, [...opener.args, url], { detached: true, stdio: 'ignore' });
      c.on('error', () => {});
      c.unref();
    } catch {
      /* headless / no opener — the printed URL is the fallback */
    }
  } else {
    io.out('  (headless — open the URL above in your browser)');
  }
  return 0;
}
