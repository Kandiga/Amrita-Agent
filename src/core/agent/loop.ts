import type {
  AgentEvent,
  ChatMessage,
  LaneEvent,
  Project,
  ToolCall,
  ToolContext,
  ToolResult,
} from '../../shared/types.ts';
import { loadConfig } from '../../shared/config.ts';
import { getProvider } from '../providers/registry.ts';
import { resolveActiveProviderId } from '../providers/resolver.ts';
import { visibleTools, executeTool, type ToolFilter } from '../tools/registry.ts';
import { buildContext } from './context-builder.ts';
import { appendMessage, getMessages, touchSession } from '../store/sessions.ts';
import { log } from '../../shared/util.ts';

export interface RunOptions {
  sessionId: string;
  project: Project | null;
  channel: string;
  chatId?: string | null;
  userText: string;
  signal?: AbortSignal;
  toolFilter?: ToolFilter;
  /** Override the configured model, e.g. per-project default. */
  model?: { provider: string; model: string };
}

/**
 * The agent loop: persist user turn → context → provider stream → execute
 * tool calls → repeat until the model ends its turn. Small on purpose —
 * failover, compression and prompt building live in their own modules.
 */
export async function* runAgent(opts: RunOptions): AsyncGenerator<AgentEvent> {
  const config = loadConfig();
  const signal = opts.signal ?? new AbortController().signal;
  // Resolve `auto` (and pass concrete ids through unchanged) before use.
  const activeProvider = resolveActiveProviderId(config.model.provider);
  const modelChoice = opts.model ??
    (opts.project?.defaultModel
      ? { provider: activeProvider, model: opts.project.defaultModel }
      : { provider: activeProvider, model: config.model.model });

  appendMessage(opts.sessionId, { role: 'user', content: opts.userText });
  touchSession(opts.sessionId, opts.userText.slice(0, 60));

  const laneEvents: LaneEvent[] = [];
  const toolCtx: ToolContext = {
    projectSlug: opts.project?.slug ?? null,
    sessionId: opts.sessionId,
    channel: opts.channel,
    chatId: opts.chatId ?? null,
    workingDir: opts.project?.workingDir ?? null,
    emitLane: (e) => laneEvents.push(e),
    signal,
  };

  const candidates = [modelChoice, ...config.fallback];
  let turns = 0;

  outer: while (turns < config.agent.maxTurns) {
    turns++;
    if (signal.aborted) {
      yield { type: 'done', reason: 'aborted' };
      return;
    }

    const history = getMessages(opts.sessionId);
    const { system, messages } = buildContext(opts.project, history, opts.channel);
    const tools = visibleTools(opts.toolFilter).map(({ handler: _h, ...spec }) => spec);

    let text = '';
    const calls: ToolCall[] = [];
    let stopReason: 'end' | 'tool-use' | 'max-tokens' | null = null;
    let errored: string | null = null;

    for (let c = 0; c < candidates.length; c++) {
      const candidate = candidates[c]!;
      errored = null;
      try {
        const provider = getProvider(candidate.provider);
        for await (const event of provider.chat({
          model: candidate.model,
          system,
          messages,
          tools,
          maxTokens: config.model.maxTokens,
          signal,
        })) {
          if (event.type === 'text') {
            text += event.delta;
            yield { type: 'text', delta: event.delta };
          } else if (event.type === 'tool-call') {
            calls.push(event.call);
          } else if (event.type === 'stop') {
            stopReason = event.reason;
          } else if (event.type === 'error') {
            errored = event.message;
            break;
          }
        }
      } catch (err) {
        errored = err instanceof Error ? err.message : String(err);
      }
      if (!errored) break;
      log('agent', `provider ${candidate.provider}/${candidate.model} failed: ${errored}`);
      if (c < candidates.length - 1) {
        yield { type: 'text', delta: `\n_(falling back to ${candidates[c + 1]!.provider})_\n` };
      }
    }

    if (errored) {
      yield { type: 'error', message: errored };
      yield { type: 'done', reason: 'complete' };
      return;
    }

    const assistantMessage: ChatMessage = {
      role: 'assistant',
      content: text,
      toolCalls: calls.length ? calls : undefined,
    };
    // Never persist a fully-empty assistant turn — it would corrupt the
    // alternating message sequence some providers require.
    if (text || calls.length) {
      appendMessage(opts.sessionId, assistantMessage);
      yield { type: 'turn-end', message: assistantMessage };
    }

    if (!calls.length || stopReason !== 'tool-use') {
      yield { type: 'done', reason: 'complete' };
      return;
    }

    // Execute tool calls sequentially (deterministic, easier to audit).
    const results: ToolResult[] = [];
    for (const call of calls) {
      yield { type: 'tool-start', call };
      const result = await executeTool(call, toolCtx, opts.toolFilter);
      results.push(result);
      yield { type: 'tool-end', result };
      // Surface lane events produced during the tool run.
      while (laneEvents.length) yield { type: 'lane', lane: laneEvents.shift()! };
      if (signal.aborted) {
        appendMessage(opts.sessionId, { role: 'tool', content: '', toolResults: results });
        yield { type: 'done', reason: 'aborted' };
        return;
      }
    }
    appendMessage(opts.sessionId, { role: 'tool', content: '', toolResults: results });
    continue outer;
  }

  yield { type: 'error', message: `Reached max turns (${config.agent.maxTurns}).` };
  yield { type: 'done', reason: 'max-turns' };
}
