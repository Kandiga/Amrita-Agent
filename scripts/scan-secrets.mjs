#!/usr/bin/env node
// Zero-dependency secret scan over git-TRACKED files (node built-ins only, in the
// deploy/serve-web.mjs style). Enforces the quality bar's "precise secret scan before
// push" rule (docs/.claude/rules/amrita-quality-bar.md) — the rule existed; this is its
// executable owner. Exits 1 on a probable real credential, 0 when clean.
//
// Tuning: patterns are LENGTH-GATED to match real vendor keys (which are long) but NOT
// this repo's deliberate test fixtures (e.g. `sk-ant-must-not-leak`, `ghp_must_not_leak`,
// which are short and marker-tagged). A second allowlist skips any line carrying a
// fixture marker. A real key pasted into a test WILL still trip this — that is the point.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

/** High-confidence credential shapes. Lengths chosen to clear real keys, not fixtures. */
const PATTERNS = [
  { name: 'anthropic-key', re: /sk-ant-[A-Za-z0-9_-]{80,}/ },
  { name: 'openai-project-key', re: /sk-proj-[A-Za-z0-9_-]{40,}/ },
  { name: 'openai-legacy-key', re: /\bsk-[A-Za-z0-9]{40,}\b/ },
  { name: 'openrouter-key', re: /sk-or-v1-[A-Fa-f0-9]{48,}/ },
  { name: 'github-pat-classic', re: /\bghp_[A-Za-z0-9]{36}\b/ },
  { name: 'github-pat-fine', re: /\bgithub_pat_[A-Za-z0-9_]{70,}\b/ },
  { name: 'github-oauth', re: /\bgh[ous]_[A-Za-z0-9]{36}\b/ },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'aws-access-key-id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'slack-token', re: /\bxox[baprs]-[0-9A-Za-z-]{20,}/ },
  { name: 'telegram-bot-token', re: /\b[0-9]{9,10}:AA[0-9A-Za-z_-]{33}\b/ },
  { name: 'stripe-secret-key', re: /\b[rs]k_live_[0-9A-Za-z]{24,}\b/ },
  { name: 'sendgrid-key', re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/ },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{18,}\.[A-Za-z0-9_-]{18,}\.[A-Za-z0-9_-]{18,}\b/ },
  { name: 'private-key-block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/ },
];

/** A line containing any of these is a known-safe fixture/placeholder — never a real leak. */
const FIXTURE_MARKERS = [
  'must-not-leak',
  'must_not_leak',
  'placeholder',
  'for-tests',
  'for_tests',
  'fake-',
  'fake_',
  'definitelyasecret',
  'example',
  'dummy',
  'redacted',
  'not-a-real',
  'notarealkey',
  'xxxxx',
];

/** Files we never scan for content secrets (own scanner, lockfile noise is huge). */
const SKIP = [/^scripts\/scan-secrets\.mjs$/, /(^|\/)pnpm-lock\.yaml$/];

function trackedFiles() {
  return execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
}

function isProbablyText(path) {
  try {
    if (statSync(path).size > 2 * 1024 * 1024) return false; // skip >2MB blobs
    const buf = readFileSync(path);
    return !buf.includes(0); // NUL byte → binary
  } catch {
    return false;
  }
}

function redact(match) {
  const head = match.slice(0, 4);
  return `${head}… (${match.length} chars)`;
}

const findings = [];
for (const file of trackedFiles()) {
  if (SKIP.some((re) => re.test(file)) || !isProbablyText(file)) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const lower = line.toLowerCase();
    if (FIXTURE_MARKERS.some((m) => lower.includes(m))) return;
    for (const { name, re } of PATTERNS) {
      const m = re.exec(line);
      if (m) findings.push({ file, line: i + 1, name, redacted: redact(m[0]) });
    }
  });
}

if (findings.length > 0) {
  console.error(`\n✗ secret scan: ${findings.length} probable credential(s) in tracked files:\n`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  [${f.name}]  ${f.redacted}`);
  }
  console.error(
    '\nIf a hit is a genuine test fixture, tag its line with a marker (e.g. "must-not-leak")',
  );
  console.error('or move it out of tracked files. If it is a real key: ROTATE it, then purge.\n');
  process.exit(1);
}

console.log(`✓ secret scan clean — ${trackedFiles().length} tracked files, no credentials found`);
