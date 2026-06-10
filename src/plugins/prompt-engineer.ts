import type { Project } from '../shared/types.ts';
import { loadConfig } from '../shared/config.ts';
import { getProvider } from '../core/providers/registry.ts';
import { readVaultFile } from '../core/memory/vault.ts';
import { truncate } from '../shared/util.ts';

/**
 * The prompt-engineering plugin: turns a user intent into a precise,
 * project-aware brief for a downstream agent (Claude Code, Codex, Open Design).
 *
 * Encodes Anthropic's published guidance: structured system prompts
 * (role → context → task → constraints → success criteria → output contract),
 * XML-tagged sections, explicit success criteria, context discipline.
 * Sources: Anthropic prompt-engineering docs, "Building Effective Agents",
 * "Claude Code best practices", "Writing effective tools for agents".
 */

const BRIEF_WRITER_SYSTEM = `You are a prompt engineer writing a brief for a downstream coding/design agent.
Given a user intent and project context, produce a single, precise task brief.

Rules (from Anthropic's prompt-engineering guidance):
- Structure with XML tags: <role>, <context>, <task>, <constraints>, <success_criteria>, <output_contract>.
- Be clear and direct. State the task explicitly; no vague "improve things".
- Include only context the downstream agent needs — high-signal, no history dumps.
- Constraints must include the project's do-not-break facts when given.
- Success criteria must be checkable (builds, tests, visible behavior).
- The output contract states what the agent must report back (files changed, how verified).
- Keep the whole brief under 500 words. No preamble, output only the brief.`;

export async function generateBrief(
  intent: string,
  project: Project | null,
  targetTool: string,
): Promise<string> {
  const config = loadConfig();
  const fallbackBrief = [
    `<task>${intent}</task>`,
    project ? `<context>Project: ${project.name}${project.workingDir ? ` at ${project.workingDir}` : ''}</context>` : '',
    `<output_contract>Report files changed and how the result was verified.</output_contract>`,
  ]
    .filter(Boolean)
    .join('\n');

  if (!config.promptEngineer.enabled) return fallbackBrief;

  const aux = config.auxiliary ?? config.model;
  const contextParts: string[] = [`Target tool: ${targetTool}`, `User intent: ${intent}`];
  if (project) {
    contextParts.push(
      `Project: ${project.name} (${project.slug})`,
      project.workingDir ? `Working directory: ${project.workingDir}` : '',
      `BRIEF.md:\n${truncate(readVaultFile(project.slug, 'BRIEF.md'), 2000)}`,
      `CONTEXT.md:\n${truncate(readVaultFile(project.slug, 'CONTEXT.md'), 3000)}`,
      `TASKS.md:\n${truncate(readVaultFile(project.slug, 'TASKS.md'), 1500)}`,
    );
  }

  let brief = '';
  try {
    const provider = getProvider(aux.provider);
    for await (const event of provider.chat({
      model: aux.model,
      system: BRIEF_WRITER_SYSTEM,
      messages: [{ role: 'user', content: contextParts.filter(Boolean).join('\n\n') }],
      tools: [],
      maxTokens: 1200,
      signal: AbortSignal.timeout(60_000),
    })) {
      if (event.type === 'text') brief += event.delta;
      if (event.type === 'error') throw new Error(event.message);
    }
  } catch {
    return fallbackBrief;
  }
  return brief.trim() || fallbackBrief;
}
