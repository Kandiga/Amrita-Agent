import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'amrita-prov-'));
process.env.AMRITA_HOME = home;
// Default: point the Claude CLI at a path that cannot exist, so most tests run
// the graceful-degradation paths and never depend on a real `claude` install.
const MISSING_BIN = join(home, 'no-such-claude-binary');
process.env.AMRITA_CLAUDE_BIN = MISSING_BIN;

// A stub `claude` that reports a healthy subscription login — used to exercise
// the logged-in paths deterministically, without a real install.
const STUB_BIN = join(home, 'claude-stub.sh');

const { ensureHome } = await import('../src/shared/paths.ts');
const { setSecret, setConfigValue } = await import('../src/shared/config.ts');
const { closeDb } = await import('../src/core/store/db.ts');
const {
  builtinProfiles,
  listProfiles,
  getProvider,
  resolveProfile,
  providerNeedsApiKey,
  providerStateLabel,
  isProviderHealthy,
  recommendProvider,
} = await import('../src/core/providers/registry.ts');
const { claudeAuthStatus } = await import('../src/core/providers/claude-cli.ts');
const { checkModelProvider } = await import('../src/cli/commands/doctor.ts');
import type { ChatRequest, ProviderStreamEvent } from '../src/shared/types.ts';

before(() => {
  ensureHome();
  writeFileSync(
    STUB_BIN,
    '#!/usr/bin/env bash\necho \'{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}\'\n',
  );
  chmodSync(STUB_BIN, 0o755);
});
after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

/** Run a body with AMRITA_CLAUDE_BIN temporarily pointed at a stub. */
function withClaudeBin<T>(bin: string, fn: () => T): T {
  const prev = process.env.AMRITA_CLAUDE_BIN;
  process.env.AMRITA_CLAUDE_BIN = bin;
  try {
    return fn();
  } finally {
    process.env.AMRITA_CLAUDE_BIN = prev;
  }
}

test('registry: claude-code is a keyless local_cli_login provider', () => {
  const p = builtinProfiles['claude-code']!;
  assert.equal(p.authMode, 'local_cli_login');
  assert.equal(p.keyEnv, null);
  assert.equal(p.api, 'claude-cli');
  assert.ok(getProvider('claude-code').chat);
  assert.equal(resolveProfile('claude-code').id, 'claude-code');
});

test('setup logic: local login and local endpoints never need an API key', () => {
  assert.equal(providerNeedsApiKey(builtinProfiles['claude-code']!), false);
  assert.equal(providerNeedsApiKey(builtinProfiles['ollama']!), false);
  assert.equal(providerNeedsApiKey(builtinProfiles['anthropic']!), true);
});

test('provider state: honest configured / needs-setup / local / local-login', () => {
  assert.equal(providerStateLabel(builtinProfiles['claude-code']!), 'local-login');
  assert.equal(providerStateLabel(builtinProfiles['ollama']!), 'local');
  assert.equal(providerStateLabel(builtinProfiles['anthropic']!), 'needs-setup');
  setSecret('ANTHROPIC_API_KEY', 'test-key-not-a-secret');
  assert.equal(providerStateLabel(builtinProfiles['anthropic']!), 'configured');
});

test('recommend: switches off an incomplete anthropic to claude-code when logged in', () => {
  const rec = recommendProvider('anthropic', listProfiles(), {
    claudeLoggedIn: true,
    hasKey: () => false, // anthropic has no key → incomplete
  });
  assert.equal(rec, 'claude-code');
});

test('recommend: keeps the current provider when it is already healthy', () => {
  const rec = recommendProvider('anthropic', listProfiles(), {
    claudeLoggedIn: true, // even with claude available...
    hasKey: (k) => k === 'ANTHROPIC_API_KEY', // ...anthropic is healthy, so keep it
  });
  assert.equal(rec, 'anthropic');
});

test('recommend: keeps an explicitly chosen local endpoint, does not hijack to claude', () => {
  const rec = recommendProvider('ollama', listProfiles(), {
    claudeLoggedIn: true,
    hasKey: () => false,
  });
  assert.equal(rec, 'ollama');
});

test('recommend: falls back to first API provider when nothing is configured', () => {
  const rec = recommendProvider('anthropic', listProfiles(), {
    claudeLoggedIn: false,
    hasKey: () => false,
  });
  assert.equal(rec, 'anthropic'); // first api_key provider, will be flagged as needing a key
});

test('isProviderHealthy: api needs key, login needs login, local always configured', () => {
  const yesKey = { claudeLoggedIn: false, hasKey: () => true };
  const noKey = { claudeLoggedIn: false, hasKey: () => false };
  assert.equal(isProviderHealthy(builtinProfiles['anthropic']!, yesKey), true);
  assert.equal(isProviderHealthy(builtinProfiles['anthropic']!, noKey), false);
  assert.equal(isProviderHealthy(builtinProfiles['claude-code']!, { claudeLoggedIn: true, hasKey: () => false }), true);
  assert.equal(isProviderHealthy(builtinProfiles['ollama']!, noKey), true);
});

test('claude auth status: not-installed for a missing binary, no throw', () => {
  const st = claudeAuthStatus();
  assert.equal(st.installed, false);
  assert.equal(st.loggedIn, false);
});

test('claude auth status: reads logged-in subscription from the CLI', () => {
  const st = withClaudeBin(STUB_BIN, () => claudeAuthStatus());
  assert.equal(st.installed, true);
  assert.equal(st.loggedIn, true);
  assert.equal(st.subscriptionType, 'max');
});

test('doctor: claude-code is healthy when the CLI reports logged in', async () => {
  setConfigValue('model.provider', 'claude-code');
  setConfigValue('model.model', 'default');
  const result = await withClaudeBin(STUB_BIN, () => checkModelProvider());
  assert.equal(result.status, 'ok');
  assert.match(result.detail, /logged in via Claude Code/);
  assert.ok(!/ANTHROPIC_API_KEY/.test(result.detail), 'must not nag about an API key after choosing claude-code');
});

test('claude-cli provider: degrades with a helpful error when the CLI is missing', async () => {
  const req: ChatRequest = {
    model: 'default',
    system: 'be brief',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    maxTokens: 256,
    signal: new AbortController().signal,
  };
  const events: ProviderStreamEvent[] = [];
  for await (const e of getProvider('claude-code').chat(req)) events.push(e);
  const error = events.find((e) => e.type === 'error') as { type: 'error'; message: string } | undefined;
  assert.ok(error, 'a missing CLI must surface an error event, not hang or throw');
  assert.match(error!.message, /Claude Code CLI not found|not logged in|setup/i);
});

test('docs: install guide spells out the Claude Code local-login flow', () => {
  const guide = readFileSync(new URL('../docs/install.md', import.meta.url), 'utf8');
  for (const needle of ['Claude Code local login', 'claude auth login', 'amrita setup', 'amrita doctor']) {
    assert.ok(guide.includes(needle), `install.md should mention "${needle}"`);
  }
});
