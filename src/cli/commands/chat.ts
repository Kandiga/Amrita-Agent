import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import '../../core/tools/index.ts';
import '../../connectors/index.ts';
import { runAgent } from '../../core/agent/loop.ts';
import { createSession, listSessions } from '../../core/store/sessions.ts';
import { getProject, listProjects } from '../../projects/manager.ts';
import { summarizeSession } from '../../core/agent/summarizer.ts';
import type { Project } from '../../shared/types.ts';

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

export async function chatCommand(args: string[]): Promise<void> {
  let project: Project | null = null;
  const projectFlag = args.indexOf('--project');
  if (projectFlag !== -1 && args[projectFlag + 1]) {
    project = getProject(args[projectFlag + 1]!);
    if (!project) {
      console.error(`Unknown project: ${args[projectFlag + 1]}`);
      process.exit(1);
    }
  }

  let session = createSession(project?.slug ?? null, 'cli');
  const contextName = project ? `📁 ${project.name}` : 'main Amrita';
  console.log(`${BOLD}Amrita${RESET} ${DIM}— ${contextName} · session ${session.id} · /help for commands${RESET}\n`);

  const rl = createInterface({ input: stdin, output: stdout });
  let abort: AbortController | null = null;

  // Ctrl+C during a run aborts the run; at the prompt it exits.
  rl.on('SIGINT', () => {
    if (abort) {
      abort.abort();
      console.log(`\n${DIM}(interrupted)${RESET}`);
    } else {
      rl.close();
    }
  });

  while (true) {
    let line: string;
    try {
      line = (await rl.question(`${CYAN}you ›${RESET} `)).trim();
    } catch {
      break; // closed
    }
    if (!line) continue;

    if (line === '/exit' || line === '/quit') break;
    if (line === '/help') {
      console.log(
        `${DIM}/new — fresh session · /projects — list & switch · /main — leave project · /sessions — recent · /where — current context · /exit${RESET}`,
      );
      continue;
    }
    if (line === '/where') {
      console.log(`${DIM}${contextName} · session ${session.id}${RESET}`);
      continue;
    }
    if (line === '/new') {
      session = createSession(project?.slug ?? null, 'cli');
      console.log(`${DIM}new session ${session.id}${RESET}`);
      continue;
    }
    if (line === '/main') {
      rl.close();
      return chatCommand([]);
    }
    if (line === '/projects') {
      const projects = listProjects();
      if (!projects.length) {
        console.log(`${DIM}no projects yet — ask Amrita to create one${RESET}`);
        continue;
      }
      projects.forEach((p, i) => console.log(`  ${i + 1}. ${p.name} (${p.slug})`));
      const pick = (await rl.question(`${DIM}switch to # (or empty to stay):${RESET} `)).trim();
      const idx = Number(pick) - 1;
      if (projects[idx]) {
        rl.close();
        return chatCommand(['--project', projects[idx]!.slug]);
      }
      continue;
    }
    if (line === '/sessions') {
      for (const s of listSessions(project?.slug ?? null, 10)) {
        console.log(`  ${s.id} ${DIM}${new Date(s.lastActiveAt).toLocaleString()} ${s.title ?? ''}${RESET}`);
      }
      continue;
    }

    abort = new AbortController();
    stdout.write(`${BOLD}amrita ›${RESET} `);
    try {
      for await (const event of runAgent({
        sessionId: session.id,
        project,
        channel: 'cli',
        userText: line,
        signal: abort.signal,
      })) {
        if (event.type === 'text') stdout.write(event.delta);
        else if (event.type === 'tool-start') {
          stdout.write(`\n${DIM}⚙ ${event.call.name}…${RESET}`);
        } else if (event.type === 'tool-end') {
          stdout.write(`${DIM} ${event.result.isError ? '✗' : '✓'}${RESET}\n`);
        } else if (event.type === 'lane' && event.lane.kind === 'output') {
          stdout.write(`${DIM}${event.lane.text}${RESET}`);
        } else if (event.type === 'error') {
          stdout.write(`\n${BOLD}error:${RESET} ${event.message}\n`);
        }
      }
    } finally {
      abort = null;
    }
    stdout.write('\n\n');
  }

  rl.close();
  // Fire-and-forget summary so the vault stays current.
  await summarizeSession(session.id, project?.slug ?? null).catch(() => {});
  console.log(`${DIM}bye${RESET}`);
}
