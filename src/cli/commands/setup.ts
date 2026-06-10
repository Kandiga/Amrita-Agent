import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadConfig, saveConfig, setSecret, getSecret } from '../../shared/config.ts';
import { listProfiles } from '../../core/providers/registry.ts';

/**
 * Guided setup wizard: provider → model → telegram → done.
 * Honest by design: it never pretends something is connected.
 */
export async function setupCommand(_args: string[]): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  const config = loadConfig(true);
  console.log('Amrita setup — press Enter to keep the [default].\n');

  // 1. Provider
  const profiles = listProfiles();
  console.log('Providers:');
  profiles.forEach((p, i) => {
    const configured = p.keyEnv && getSecret(p.keyEnv) ? ' (key set)' : '';
    console.log(`  ${i + 1}. ${p.label}${p.authMode === 'local_endpoint' ? ' — local' : ''}${configured}`);
  });
  const pickRaw = (await rl.question(`\nProvider for Amrita's brain [${config.model.provider}]: `)).trim();
  let profile = profiles.find((p) => p.id === config.model.provider) ?? profiles[0]!;
  if (pickRaw) {
    const byIndex = profiles[Number(pickRaw) - 1];
    const byId = profiles.find((p) => p.id === pickRaw);
    profile = byIndex ?? byId ?? profile;
  }
  const providerChanged = config.model.provider !== profile.id;
  config.model.provider = profile.id;

  // 2. API key
  if (profile.keyEnv && !getSecret(profile.keyEnv)) {
    const key = (await rl.question(`${profile.keyEnv} (input hidden is not supported — paste key, or Enter to skip): `)).trim();
    if (key) {
      setSecret(profile.keyEnv, key);
      console.log('  saved to ~/.amrita/secrets.env (0600)');
    } else {
      console.log(`  skipped — Amrita won't be able to think until ${profile.keyEnv} is set.`);
    }
  }

  // 3. Model — switching provider suggests its default; same provider keeps the current model.
  const suggested = providerChanged ? profile.defaultModel : config.model.model;
  const model = (await rl.question(`Model [${suggested}]: `)).trim();
  config.model.model = model || suggested;

  // 4. Telegram
  const wantTg = (await rl.question(`Enable Telegram? (y/N) [${config.channels.telegram.enabled ? 'y' : 'n'}]: `))
    .trim()
    .toLowerCase();
  if (wantTg === 'y' || wantTg === 'yes') {
    config.channels.telegram.enabled = true;
    if (!getSecret('TELEGRAM_BOT_TOKEN')) {
      const token = (await rl.question('Bot token from @BotFather (Enter to skip): ')).trim();
      if (token) setSecret('TELEGRAM_BOT_TOKEN', token);
    }
  } else if (wantTg === 'n' || wantTg === 'no') {
    config.channels.telegram.enabled = false;
  }

  // 5. Public URL (for magic links behind a domain)
  const publicUrl = (await rl.question(`Public URL for web links (Enter for http://127.0.0.1:${config.daemon.port}): `)).trim();
  config.daemon.publicUrl = publicUrl || null;

  saveConfig(config);
  rl.close();
  console.log(`\nDone. Next steps:
  amrita doctor   — verify everything
  amrita daemon   — start the daemon (web UI + telegram)
  amrita chat     — talk from this terminal right now`);
}
