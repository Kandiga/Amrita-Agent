import type { RegisteredTool, ToolContext, ToolResult, ToolCall } from '../../shared/types.ts';
import { loadConfig } from '../../shared/config.ts';
import { audit } from '../store/audit.ts';
import { truncate } from '../../shared/util.ts';

const tools = new Map<string, RegisteredTool>();

export function registerTool(tool: RegisteredTool): void {
  tools.set(tool.name, tool);
}

export interface ToolFilter {
  /** Extra toolsets to strip in this context (e.g. cron strips messaging/scheduling/interactive). */
  stripToolsets?: string[];
}

/** Tools visible to the model in a given context, after permission filtering. */
export function visibleTools(filter: ToolFilter = {}): RegisteredTool[] {
  const disabled = new Set([
    ...loadConfig().toolsets.disabled,
    ...(filter.stripToolsets ?? []),
  ]);
  return [...tools.values()].filter((t) => !disabled.has(t.toolset));
}

const MAX_RESULT_CHARS = 24_000;

export async function executeTool(
  call: ToolCall,
  ctx: ToolContext,
  filter: ToolFilter = {},
): Promise<ToolResult> {
  const tool = tools.get(call.name);
  const allowed = tool && visibleTools(filter).some((t) => t.name === call.name);
  audit(
    'tool-call',
    { name: call.name, args: Object.keys(call.arguments), allowed: Boolean(allowed) },
    { sessionId: ctx.sessionId, projectSlug: ctx.projectSlug },
  );
  if (!tool || !allowed) {
    return {
      toolCallId: call.id,
      name: call.name,
      content: `Tool "${call.name}" is not available in this context.`,
      isError: true,
    };
  }
  try {
    const content = await tool.handler(call.arguments, ctx);
    return { toolCallId: call.id, name: call.name, content: truncate(content, MAX_RESULT_CHARS) };
  } catch (err) {
    return {
      toolCallId: call.id,
      name: call.name,
      content: `Error: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}
