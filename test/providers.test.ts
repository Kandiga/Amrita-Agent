import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'amrita-prov-'));
process.env.AMRITA_HOME = home;
// Point the Claude CLI at a path that cannot exist, so tests never depend on a
// real `claude` install and exercise the graceful-degradation paths.
process.env.AMRITA_CLAUDE_BIN = join(home, 'no-such-claude-binary');

const { ensureHome } = await import('../src/shared/paths.ts');
const { setSecret } = await import('../src/shared/config.ts');
const { closeDb } = await import('../src/core/store/db.ts');
const {
  builtinProfiles,
  getProvider,
  resolveProfile,
  providerNeedsApiKey,
  providerStateLabel,
} = await import('../src/core/providers/registry.ts');
const { claudeAuthStatus } = await import('../src/core/providers/claude-cli.ts');
import type { ChatRequest, ProviderStreamEvent } from '../src/shared/types.ts';

before(() => ensureHome());
after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

test('registry: claude-code is a keyless local_cli_login provider', () => {
  const p = builtinProfiles['claude-code']!;
  assert.equal(p.authMode, 'local_cli_login');
  assert.equal(p.keyEnv, null);
  assert.equal(p.api, 'claude-cli');
  // It must be constructable through the normal provider factory.
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

test('claude auth status: reports not-installed for a missing binary, no throw', () => {
  const st = claudeAuthStatus();
  assert.equal(st.installed, false);
  assert.equal(st.loggedIn, false);
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
