import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { amritaHome, parseEnvFile, secretsEnvPath, writeSecretsEnv } from '@amrita/daemon';
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
 * is down (daemon + web), waits for readiness, and prints/opens one URL with a
 * one-time #token= so the bearer is never hand-copied. Honest by construction:
 * it never claims the UI opened on a headless host, and refuses clearly when the
 * web build is missing rather than serving a 404.
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
  const token = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join(
    '',
  );
  writeSecretsEnv({ AMRITA_AUTH_TOKEN: token }, env);
  process.env.AMRITA_AUTH_TOKEN = token;
  io.out(`  generated a stable control token → ${path} (0600)`);
  return token;
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
  const spawned: ChildProcess[] = [];

  // 1) daemon
  if (!(await healthOk(plan.daemonHealthUrl))) {
    io.out('  starting the daemon…');
    const child = spawn('amritad', ['--http', '--port', String(daemonPort)], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, AMRITA_AUTH_TOKEN: token },
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

  // 3) one URL with a one-time #token= — the SPA adopts it then clears the hash.
  const url = openUrl(webPort, token);
  io.out('');
  io.out(`  Amrita is open at:  ${url}`);
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
