import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Manage Amrita as a systemd **user** service. Honest about environment:
 * on WSL/containers without systemd it recommends the foreground `amrita
 * daemon` instead of pretending a service was installed. Every failure prints
 * the exact `journalctl` command to investigate (Hermes pattern).
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const UNIT = 'amrita.service';
const unitPath = join(homedir(), '.config', 'systemd', 'user', UNIT);

function isWsl(): boolean {
  try {
    return /microsoft|wsl/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

function systemctl(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('systemctl', args, { encoding: 'utf8' });
  return { ok: !r.error && r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

function hasUserSystemd(): boolean {
  const r = spawnSync('systemctl', ['--user', 'is-system-running'], { encoding: 'utf8' });
  // Any answer other than ENOENT means a user manager is reachable
  // ("running"/"degraded"/"starting" all count).
  return !r.error;
}

const journalHint = 'journalctl --user -u amrita -n 100 --no-pager';

function noSystemdGuidance(): void {
  console.log('No systemd user manager is available here.');
  if (isWsl()) {
    console.log('On WSL, either enable systemd (add to /etc/wsl.conf:\n  [boot]\n  systemd=true\nthen `wsl --shutdown` and reopen), or just run the daemon in the foreground:');
  } else {
    console.log('Run the daemon in the foreground instead:');
  }
  console.log('  amrita daemon');
}

function install(): void {
  if (!hasUserSystemd()) {
    noSystemdGuidance();
    process.exitCode = 1;
    return;
  }
  mkdirSync(dirname(unitPath), { recursive: true });
  const unit = `[Unit]
Description=Amrita Agent daemon (web UI, channels, scheduler)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${process.execPath} ${join(repoRoot, 'src', 'cli', 'main.ts')} daemon
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
NoNewPrivileges=true

[Install]
WantedBy=default.target
`;
  writeFileSync(unitPath, unit, { mode: 0o644 });
  systemctl(['--user', 'daemon-reload']);
  const enabled = systemctl(['--user', 'enable', '--now', UNIT]);
  if (!enabled.ok) {
    console.log(`Installed the unit but failed to start it.\n${enabled.out}`);
    console.log(`Investigate: ${journalHint}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Installed and started amrita.service (user scope).
  Status: amrita service status
  Logs:   ${journalHint}
  Tip: enable lingering so it runs after logout:  sudo loginctl enable-linger ${process.env.USER ?? ''}`);
}

function uninstall(): void {
  systemctl(['--user', 'disable', '--now', UNIT]);
  if (existsSync(unitPath)) rmSync(unitPath);
  systemctl(['--user', 'daemon-reload']);
  console.log('Removed amrita.service (your ~/.amrita data is untouched).');
}

function status(): void {
  if (!hasUserSystemd()) {
    noSystemdGuidance();
    return;
  }
  const active = systemctl(['--user', 'is-active', UNIT]);
  const enabled = systemctl(['--user', 'is-enabled', UNIT]);
  console.log(`amrita.service: ${active.out || 'unknown'} (${enabled.out || 'not installed'})`);
  console.log(`Logs: ${journalHint}`);
}

function logs(): void {
  const r = spawnSync('journalctl', ['--user', '-u', 'amrita', '-n', '100', '--no-pager'], {
    stdio: 'inherit',
  });
  if (r.error) console.log(`Could not read logs. Try: ${journalHint}`);
}

export async function serviceCommand(args: string[]): Promise<void> {
  const sub = args[0] ?? 'status';
  switch (sub) {
    case 'install':
      return install();
    case 'uninstall':
    case 'remove':
      return uninstall();
    case 'status':
      return status();
    case 'logs':
      return logs();
    default:
      console.log(`Usage: amrita service <install|status|logs|uninstall>
  install    install + start a systemd user service
  status     is it running / enabled?
  logs       recent service logs
  uninstall  stop + remove the service (data kept)`);
  }
}
