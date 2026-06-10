import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { ChatMessage, Project } from '../../shared/types.ts';
import { loadConfig } from '../../shared/config.ts';
import { estimateTokens } from '../../shared/util.ts';
import {
  readVaultFile,
  recentSessionSummaries,
  readUserMemory,
} from '../memory/vault.ts';

const IDENTITY = `You are Amrita, a chat-first project operating agent built by Nethanel Kol.
You help your user create, manage, remember, design, code, QA and ship projects through conversation.
You are concise, warm, and practical. You answer in the language the user writes in (Hebrew or English).
When real work is needed you use tools; you narrate what you did, not what you might do.
When a task fits a connector (Claude Code for coding, Open Design for design), prefer delegating
to it with a well-written brief over doing long work inline.
Never invent results: if a tool failed or something is not configured, say so plainly.`;

function gitSnapshot(workingDir: string): string {
  try {
    const branch = execFileSync('git', ['-C', workingDir, 'branch', '--show-current'], {
      encoding: 'utf8',
      timeout: 3000,
    }).trim();
    const logOutput = execFileSync('git', ['-C', workingDir, 'log', '--oneline', '-5'], {
      encoding: 'utf8',
      timeout: 3000,
    }).trim();
    const status = execFileSync('git', ['-C', workingDir, 'status', '--porcelain'], {
      encoding: 'utf8',
      timeout: 3000,
    }).trim();
    return `branch: ${branch}\nrecent commits:\n${logOutput}\nworking tree: ${status ? `${status.split('\n').length} changed file(s)` : 'clean'}`;
  } catch {
    return '(not a git repository or git unavailable)';
  }
}

function clip(text: string, budgetTokens: number): string {
  const max = budgetTokens * 4;
  return text.length <= max ? text : text.slice(0, max) + '\n…[clipped]';
}

export interface BuiltContext {
  system: string;
  /** Conversation tail that fits the budget. */
  messages: ChatMessage[];
}

/**
 * Assemble the per-turn context: identity + user memory + project pack +
 * conversation tail — token-budgeted, never dumping irrelevant history.
 */
export function buildContext(
  project: Project | null,
  history: ChatMessage[],
  channel: string,
): BuiltContext {
  const budget = loadConfig().agent.contextTokenBudget;
  const parts: string[] = [IDENTITY];

  parts.push(`\n<environment>\nchannel: ${channel}\ndate: ${new Date().toISOString().slice(0, 10)}\n</environment>`);

  const userMemory = readUserMemory();
  if (userMemory.trim()) {
    parts.push(`\n<user_memory>\n${clip(userMemory, 1500)}\n</user_memory>`);
  }

  if (project) {
    const brief = readVaultFile(project.slug, 'BRIEF.md');
    const context = readVaultFile(project.slug, 'CONTEXT.md');
    const tasks = readVaultFile(project.slug, 'TASKS.md');
    const summaries = recentSessionSummaries(project.slug, 3).join('\n---\n');
    const git =
      project.workingDir && existsSync(project.workingDir)
        ? gitSnapshot(project.workingDir)
        : null;
    parts.push(
      `\n<project name="${project.name}" slug="${project.slug}">`,
      `<brief>\n${clip(brief, 1200)}\n</brief>`,
      `<context_pack>\n${clip(context, 2000)}\n</context_pack>`,
      `<tasks>\n${clip(tasks, 1000)}\n</tasks>`,
      summaries ? `<recent_sessions>\n${clip(summaries, 1800)}\n</recent_sessions>` : '',
      git ? `<repo workingDir="${project.workingDir}">\n${git}\n</repo>` : '',
      `</project>`,
      `\nKeep this project's vault current: when the user makes a decision, record it with vault_append_decision; when tasks change, update them with vault_update.`,
    );
  } else {
    parts.push(
      `\nYou are in the main (no-project) context. The user can switch to a project at any time; if their request clearly belongs to an existing project, suggest switching or offer to create one with project_create.`,
    );
  }

  const system = parts.filter(Boolean).join('\n');

  // Budget the conversation tail (newest backwards).
  const systemTokens = estimateTokens(system);
  let remaining = Math.max(budget - systemTokens, 2000);
  const tail: ChatMessage[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    const cost = estimateTokens(m.content) + estimateTokens(JSON.stringify(m.toolCalls ?? '')) +
      estimateTokens(JSON.stringify(m.toolResults ?? ''));
    if (remaining - cost < 0 && tail.length > 0) break;
    remaining -= cost;
    tail.unshift(m);
  }
  // Never start the tail mid-exchange: Anthropic requires the first message
  // to be a user turn, and an orphan tool result breaks both wire formats.
  while (tail.length && tail[0]!.role !== 'user') tail.shift();
  return { system, messages: tail };
}
