import { loadConfig } from '../../shared/config.ts';
import { getProvider } from '../providers/registry.ts';
import {
  getMessages,
  listUnsummarizedIdleSessions,
  markSummarized,
} from '../store/sessions.ts';
import { writeSessionSummary } from '../memory/vault.ts';
import { log, truncate } from '../../shared/util.ts';

const SUMMARY_PROMPT = `Summarize this agent session for the project's memory vault.
Write 5-12 terse markdown bullets covering: what the user wanted, what was done,
decisions made, artifacts/files produced, and open follow-ups. No preamble.`;

export async function summarizeSession(sessionId: string, projectSlug: string | null): Promise<boolean> {
  const config = loadConfig();
  const aux = config.auxiliary ?? config.model;
  const messages = getMessages(sessionId);
  if (messages.length < 2) {
    markSummarized(sessionId);
    return false;
  }
  const transcript = messages
    .map((m) => {
      if (m.role === 'tool') {
        return `tools → ${(m.toolResults ?? []).map((r) => `${r.name}: ${truncate(r.content, 200)}`).join('; ')}`;
      }
      return `${m.role}: ${truncate(m.content, 1200)}`;
    })
    .join('\n');

  let summary = '';
  try {
    const provider = getProvider(aux.provider);
    for await (const event of provider.chat({
      model: aux.model,
      system: SUMMARY_PROMPT,
      messages: [{ role: 'user', content: truncate(transcript, 30_000) }],
      tools: [],
      maxTokens: 1024,
      signal: new AbortController().signal,
    })) {
      if (event.type === 'text') summary += event.delta;
      if (event.type === 'error') throw new Error(event.message);
    }
  } catch (err) {
    log('summarizer', `failed for ${sessionId}: ${err instanceof Error ? err.message : err}`);
    return false;
  }

  if (projectSlug && summary.trim()) {
    writeSessionSummary(projectSlug, sessionId, summary);
  }
  markSummarized(sessionId);
  return true;
}

/** Background pass: summarize sessions idle for over an hour. */
export async function summarizeIdleSessions(): Promise<number> {
  const idle = listUnsummarizedIdleSessions(60 * 60 * 1000);
  let done = 0;
  for (const session of idle) {
    if (await summarizeSession(session.id, session.projectSlug)) done++;
  }
  return done;
}
