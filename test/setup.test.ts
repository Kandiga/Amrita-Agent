import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'amrita-setup-'));
process.env.AMRITA_HOME = home;
const MISSING_BIN = join(home, 'no-claude');
process.env.AMRITA_CLAUDE_BIN = MISSING_BIN;
const STUB_BIN = join(home, 'claude-stub.sh');

const { ensureHome } = await import('../src/shared/paths.ts');
const { loadConfig, saveConfig, setSecret, backupConfig, setConfigValue } = await import('../src/shared/config.ts');
const { closeDb } = await import('../src/core/store/db.ts');
const { checkModelProvider } = await import('../src/cli/commands/doctor.ts');

// Provider/auto resolution must not be skewed by ambient provider keys.
const KEY_ENVS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY'];
const savedEnv: Record<string, string | undefined> = {};

before(() => {
  ensureHome();
  for (const k of KEY_ENVS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  writeFileSync(STUB_BIN, '#!/usr/bin/env bash\necho \'{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}\'\n');
  chmodSync(STUB_BIN, 0o755);
});
after(() => {
  for (const k of KEY_ENVS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

function withClaudeBin<T>(bin: string, fn: () => T): T {
  const prev = process.env.AMRITA_CLAUDE_BIN;
  process.env.AMRITA_CLAUDE_BIN = bin;
  try {
    return fn();
  } finally {
    process.env.AMRITA_CLAUDE_BIN = prev;
  }
}

test('config default: provider is auto (never a broken concrete default)', () => {
  const config = loadConfig(true);
  assert.equal(config.model.provider, 'auto');
  assert.equal(config.model.model, 'default');
  assert.equal(config._version >= 1, true);
});

test('doctor: auto with nothing configured WARNs (run setup), never a hard fail', async () => {
  setConfigValue('model.provider', 'auto');
  const r = await checkModelProvider(); // missing claude bin + no keys
  assert.equal(r.status, 'warn');
  assert.match(r.detail, /no provider configured yet/);
  assert.equal(r.fix, 'amrita setup');
});

test('doctor: auto becomes green the moment Claude Code is logged in', async () => {
  setConfigValue('model.provider', 'auto');
  const r = await withClaudeBin(STUB_BIN, () => checkModelProvider());
  assert.equal(r.status, 'ok');
  assert.match(r.detail, /auto → claude-code/);
  assert.match(r.detail, /logged in via Claude Code/);
});

test('secrets: names are validated and values stay single-line', () => {
  assert.throws(() => setSecret('bad name', 'x'), /Invalid secret name/);
  assert.throws(() => setSecret('lowercase', 'x'), /Invalid secret name/);
  setSecret('TELEGRAM_BOT_TOKEN', '  abc\n123  ');
  const secrets = readFileSync(join(home, 'secrets.env'), 'utf8');
  assert.match(secrets, /TELEGRAM_BOT_TOKEN=abc 123/);
  assert.ok(!secrets.includes('\nTELEGRAM_BOT_TOKEN=abc\n123'), 'a newline must not split one secret into two lines');
});

test('config: backupConfig copies the live config aside before mutation', () => {
  saveConfig(loadConfig(true));
  const backup = backupConfig();
  assert.ok(backup && existsSync(backup), 'a .bak file is written');
  assert.equal(readFileSync(backup!, 'utf8'), readFileSync(join(home, 'config.json'), 'utf8'));
});

test('config: a healthy concrete provider survives a reload (idempotent re-run)', () => {
  setConfigValue('model.provider', 'claude-code');
  setConfigValue('model.model', 'default');
  const reloaded = loadConfig(true);
  assert.equal(reloaded.model.provider, 'claude-code');
  assert.equal(reloaded.model.model, 'default');
});
