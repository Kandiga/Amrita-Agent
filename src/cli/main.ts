#!/usr/bin/env node
import { ensureHome } from '../shared/paths.ts';

const HELP = `
Amrita Agent — chat-first project operating agent

Usage: amrita <command> [options]

Conversation
  chat [--project <slug>]   Talk to Amrita in the terminal
  projects                  List projects

Service
  daemon                    Run the daemon in the foreground (web UI + channels + cron)
  gateway                   Alias of daemon
  service <cmd>             systemd user service: install | status | logs | uninstall
  login-link                Print a one-time web login link

Lifecycle
  setup [section]           Setup wizard; sections: model, credentials, telegram,
                            connectors, endpoint, webui, review
  status                    Show daemon/config status
  doctor                    Diagnose installation and configuration
  update                    Update Amrita from GitHub
  uninstall                 Print uninstall instructions
  version                   Print version

Run "amrita <command> --help" where applicable.
`;

async function main(): Promise<void> {
  ensureHome();
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'chat': {
      const { chatCommand } = await import('./commands/chat.ts');
      return chatCommand(args);
    }
    case 'projects': {
      const { listProjects } = await import('../projects/manager.ts');
      const projects = listProjects();
      console.log(
        projects.length
          ? projects.map((p) => `${p.slug}\t${p.name}${p.workingDir ? `\t${p.workingDir}` : ''}`).join('\n')
          : 'No projects yet. Create one by chatting: "create a project called …"',
      );
      return;
    }
    case 'daemon':
    case 'gateway': {
      const { startDaemon } = await import('../daemon/server.ts');
      return startDaemon();
    }
    case 'service': {
      const { serviceCommand } = await import('./commands/service.ts');
      return serviceCommand(args);
    }
    case 'login-link': {
      const { printLoginLink } = await import('../daemon/auth.ts');
      return printLoginLink();
    }
    case 'setup': {
      const { setupCommand } = await import('./commands/setup.ts');
      return setupCommand(args);
    }
    case 'status': {
      const { statusCommand } = await import('./commands/doctor.ts');
      return statusCommand();
    }
    case 'doctor': {
      const { doctorCommand } = await import('./commands/doctor.ts');
      return doctorCommand();
    }
    case 'update': {
      const { updateCommand } = await import('./commands/update.ts');
      return updateCommand();
    }
    case 'uninstall': {
      const { uninstallCommand } = await import('./commands/update.ts');
      return uninstallCommand();
    }
    case 'version': {
      const { readFileSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const pkg = JSON.parse(
        readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
      );
      console.log(`amrita ${pkg.version} (node ${process.version})`);
      return;
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP.trim());
      return;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP.trim());
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
