import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { audit } from '../../core/store/audit.ts';
import { paths } from '../../shared/paths.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Update from GitHub: fetch + fast-forward the install checkout.
 * (Release-tarball updates become the path once GitHub Releases exist;
 * git is the honest mechanism for the alpha.)
 */
export async function updateCommand(): Promise<void> {
  if (!existsSync(resolve(repoRoot, '.git'))) {
    console.log('This install is not a git checkout — update by re-running the installer:');
    console.log('  curl -fsSL https://raw.githubusercontent.com/Kandiga/Amrita-Agent/main/scripts/install.sh | bash');
    return;
  }
  try {
    execFileSync('git', ['-C', repoRoot, 'fetch', 'origin'], { stdio: 'inherit' });
    const behind = execFileSync(
      'git',
      ['-C', repoRoot, 'rev-list', '--count', 'HEAD..origin/main'],
      { encoding: 'utf8' },
    ).trim();
    if (behind === '0') {
      console.log('Already up to date.');
      return;
    }
    console.log(`${behind} update(s) available — applying…`);
    execFileSync('git', ['-C', repoRoot, 'pull', '--ff-only', 'origin', 'main'], { stdio: 'inherit' });
    audit('update', { commits: Number(behind) });
    console.log('\nUpdated. Restart the daemon: systemctl restart amrita (or re-run amrita daemon).');
  } catch (err) {
    console.error(`Update failed: ${err instanceof Error ? err.message : err}`);
    console.error('Repair: cd into the install dir and resolve git state, or re-run the installer.');
    process.exitCode = 1;
  }
}

export async function uninstallCommand(): Promise<void> {
  console.log(`Amrita uninstall — nothing is deleted automatically.

1. Stop and remove the service (if installed):
     systemctl --user disable --now amrita 2>/dev/null
     sudo systemctl disable --now amrita 2>/dev/null
     sudo rm -f /etc/systemd/system/amrita.service

2. Remove the install:
     rm -rf ${repoRoot}
     rm -f ~/.local/bin/amrita

3. Your data (conversations, projects, memory vaults, secrets) lives at:
     ${paths.home()}
   Keep it, back it up, or remove it explicitly:
     rm -rf ${paths.home()}
`);
}
