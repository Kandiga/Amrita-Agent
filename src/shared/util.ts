import { randomBytes } from 'node:crypto';

export function id(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

export function now(): number {
  return Date.now();
}

/** Rough token estimate (chars/4) — used for context budgeting only. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9֐-׿]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'project'
  );
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 20) + `\n…[truncated ${text.length - max} chars]`;
}

export function isoDate(at = Date.now()): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** Minimal logger with levels; writes to stderr so stdout stays clean for CLI output. */
export function log(scope: string, message: string, ...rest: unknown[]): void {
  const ts = new Date().toISOString();
  console.error(`[${ts}] [${scope}] ${message}`, ...rest);
}
