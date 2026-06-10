import type {
  ChannelAdapter,
  InboundMessage,
  OutboundButton,
} from '../shared/types.ts';
import { resolveBinding, switchContext, resetSession } from './bindings.ts';
import { runAgent } from '../core/agent/loop.ts';
import { getProject, listProjects } from '../projects/manager.ts';
import { listSessions } from '../core/store/sessions.ts';
import { log } from '../shared/util.ts';

/**
 * The gateway: channel-agnostic message router. Slash commands for
 * context switching are handled here so every channel gets the same UX;
 * everything else goes to the agent loop.
 */

const activeRuns = new Map<string, AbortController>(); // `${channel}:${chatId}`

function runKey(channel: string, chatId: string): string {
  return `${channel}:${chatId}`;
}

export async function handleInbound(
  adapter: ChannelAdapter,
  message: InboundMessage,
): Promise<void> {
  const { channel, chatId } = message;
  const text = message.text.trim();

  // ----- context commands (uniform across channels) -----
  if (text === '/start' || text === '/help') {
    await adapter.send(chatId, {
      text:
        `Hi, I'm *Amrita* — your project operating agent.\n\n` +
        `Just talk to me. Commands:\n` +
        `/projects — switch to a project\n` +
        `/main — back to main Amrita\n` +
        `/new — fresh conversation\n` +
        `/where — what context am I in?\n` +
        `/sessions — recent sessions here\n` +
        `/stop — interrupt current work`,
      markdown: true,
    });
    return;
  }

  if (text === '/projects' || text.startsWith('/project ')) {
    const projects = listProjects();
    if (!projects.length) {
      await adapter.send(chatId, {
        text: 'No projects yet — just ask me to create one ("create a project called …").',
      });
      return;
    }
    if (adapter.capabilities.buttons) {
      const rows: OutboundButton[][] = projects
        .slice(0, 20)
        .map((p) => [{ label: `📁 ${p.name}`, action: `switch:${p.slug}` }]);
      rows.push([{ label: '⌂ Main Amrita', action: 'switch:' }]);
      await adapter.send(chatId, { text: 'Pick a project:', buttons: rows });
    } else {
      await adapter.send(chatId, {
        text:
          'Projects:\n' +
          projects.map((p) => `- ${p.name} → /switch_${p.slug.replaceAll('-', '_')}`).join('\n'),
      });
    }
    return;
  }

  const switchMatch =
    text.match(/^switch:(.*)$/) ?? text.match(/^\/switch[_ ]([\w-]+)$/);
  if (switchMatch !== null) {
    const slug = (switchMatch[1] ?? '').replaceAll('_', '-').trim() || null;
    const project = slug ? getProject(slug) : null;
    if (slug && !project) {
      await adapter.send(chatId, { text: `Unknown project: ${slug}` });
      return;
    }
    const binding = switchContext(channel, chatId, project?.slug ?? null);
    await adapter.send(chatId, {
      text: project
        ? `🔄 Switched to *📁 ${project.name}*.\nNew session ${binding.sessionId}. What do you want to do?`
        : `⌂ Back to *main Amrita*. New session ${binding.sessionId}.`,
      markdown: true,
    });
    return;
  }

  if (text === '/main') {
    return handleInbound(adapter, { ...message, text: 'switch:' });
  }

  if (text === '/new' || text === '/reset') {
    const binding = resetSession(channel, chatId);
    await adapter.send(chatId, { text: `🆕 Fresh session ${binding.sessionId}.` });
    return;
  }

  if (text === '/where') {
    const binding = resolveBinding(channel, chatId);
    const project = binding.projectSlug ? getProject(binding.projectSlug) : null;
    await adapter.send(chatId, {
      text: project
        ? `You're talking to *📁 ${project.name}* (session ${binding.sessionId}).`
        : `You're talking to *main Amrita* (session ${binding.sessionId}).`,
      markdown: true,
    });
    return;
  }

  if (text === '/sessions') {
    const binding = resolveBinding(channel, chatId);
    const sessions = listSessions(binding.projectSlug, 8);
    await adapter.send(chatId, {
      text:
        'Recent sessions here:\n' +
        sessions
          .map((s) => `- ${new Date(s.lastActiveAt).toLocaleString()} ${s.title ?? '(untitled)'}`)
          .join('\n'),
    });
    return;
  }

  if (text === '/stop') {
    const controller = activeRuns.get(runKey(channel, chatId));
    if (controller) {
      controller.abort();
      await adapter.send(chatId, { text: '⏹ Stopped.' });
    } else {
      await adapter.send(chatId, { text: 'Nothing is running.' });
    }
    return;
  }

  // ----- normal message → agent -----
  const binding = resolveBinding(channel, chatId);
  const project = binding.projectSlug ? getProject(binding.projectSlug) : null;

  // One run per chat; a new message interrupts the previous run (Hermes UX).
  activeRuns.get(runKey(channel, chatId))?.abort();
  const controller = new AbortController();
  activeRuns.set(runKey(channel, chatId), controller);

  const contextPrefix = project ? `📁 ${project.name}\n` : '';
  let pending = '';
  let lastFlush = Date.now();

  const flush = async (force = false) => {
    // Non-streaming channels get chunked progressive messages.
    if (!pending.trim()) return;
    if (!force && pending.length < 2800 && Date.now() - lastFlush < 4000) return;
    const chunk = pending;
    pending = '';
    lastFlush = Date.now();
    await adapter.send(chatId, { text: chunk, markdown: true }).catch((err) =>
      log('gateway', `send failed on ${channel}:${chatId}: ${err}`),
    );
  };

  try {
    let first = true;
    for await (const event of runAgent({
      sessionId: binding.sessionId,
      project,
      channel,
      chatId,
      userText: text,
      signal: controller.signal,
    })) {
      if (event.type === 'text') {
        if (first) {
          pending += contextPrefix;
          first = false;
        }
        pending += event.delta;
        await flush();
      } else if (event.type === 'tool-start') {
        await flush(true);
        await adapter.send(chatId, { text: `⚙ ${event.call.name}…` }).catch(() => {});
      } else if (event.type === 'lane' && event.lane.kind === 'open') {
        await adapter.send(chatId, {
          text: `🛠 ${event.lane.title} started${event.lane.url ? ` — ${event.lane.url}` : ''}`,
        }).catch(() => {});
      } else if (event.type === 'error') {
        await flush(true);
        await adapter.send(chatId, { text: `⚠️ ${event.message}` }).catch(() => {});
      }
    }
    await flush(true);
  } finally {
    if (activeRuns.get(runKey(channel, chatId)) === controller) {
      activeRuns.delete(runKey(channel, chatId));
    }
  }
}
