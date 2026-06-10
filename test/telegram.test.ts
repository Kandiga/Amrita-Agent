import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'amrita-tg-'));
process.env.AMRITA_HOME = home;

const { ensureHome } = await import('../src/shared/paths.ts');
const { setConfigValue } = await import('../src/shared/config.ts');
const { telegramUserAllowed } = await import('../src/channels/telegram/adapter.ts');

before(() => ensureHome());
after(() => rmSync(home, { recursive: true, force: true }));

test('telegram: deny-by-default when no allowlist is configured', () => {
  assert.equal(telegramUserAllowed(123), false);
  assert.equal(telegramUserAllowed(undefined), false);
});

test('telegram: only allowlisted user ids are permitted', () => {
  setConfigValue('channels.telegram.allowedUserIds', [123, 456]);
  assert.equal(telegramUserAllowed(123), true);
  assert.equal(telegramUserAllowed(456), true);
  assert.equal(telegramUserAllowed(999), false);
  assert.equal(telegramUserAllowed(undefined), false);
});
