import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

/** Root state dir. Overridable for tests/parallel installs. */
export function amritaHome(): string {
  return process.env.AMRITA_HOME ?? join(homedir(), '.amrita');
}

export const paths = {
  home: () => amritaHome(),
  config: () => join(amritaHome(), 'config.json'),
  secrets: () => join(amritaHome(), 'secrets.env'),
  db: () => join(amritaHome(), 'amrita.db'),
  projects: () => join(amritaHome(), 'projects'),
  project: (slug: string) => join(amritaHome(), 'projects', slug),
  vault: (slug: string) => join(amritaHome(), 'projects', slug, 'vault'),
  skills: () => join(amritaHome(), 'skills'),
  cron: () => join(amritaHome(), 'cron'),
  logs: () => join(amritaHome(), 'logs'),
  auth: () => join(amritaHome(), 'auth'),
  userMemory: () => join(amritaHome(), 'USER.md'),
};

/** Create the state tree (idempotent). */
export function ensureHome(): void {
  for (const dir of [
    amritaHome(),
    paths.projects(),
    paths.skills(),
    paths.cron(),
    paths.logs(),
    paths.auth(),
  ]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}
