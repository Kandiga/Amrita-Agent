import type { AmritaKernel } from '@amrita/daemon';
import {
  type Channel,
  type ChannelResult,
  type InboundUpdate,
  chunkText,
  safeMessage,
} from './types.ts';

/** The outbound surface a real Telegram bot provides — injected (faked in tests). */
export interface TelegramSender {
  sendMessage(chatId: string, text: string): Promise<void> | void;
}

export interface TelegramChannelOptions {
  /** Owner allowlist of numeric Telegram user ids. Empty ⇒ nobody (deny-by-default). */
  allowedUserIds: number[];
  /** Max characters per outbound message (Telegram ~4096). */
  chunkSize?: number;
}

const TELEGRAM_MAX = 4000;

/** `/pair CODE` → `CODE`, else null. */
function parsePairCommand(text: string): string | null {
  const m = text.trim().match(/^\/pair\s+(\S+)/i);
  return m ? (m[1] ?? null) : null;
}

/**
 * The Telegram channel skeleton. **Deny-by-default**: only allowlisted numeric
 * user ids are processed, and the gate applies to BOTH messages and callback
 * queries. An allowed owner links a Telegram identity to an Amrita project via a
 * pairing code (`/pair CODE`), after which messages run chat turns whose replies
 * are chunked to Telegram's size limit. No real Telegram API call happens here —
 * the outbound `sender` is injected. The bot token lives in env/config, never in
 * this object, the DB, events, or any output.
 */
export class TelegramChannel implements Channel {
  readonly id = 'telegram';
  private readonly kernel: AmritaKernel;
  private readonly sender: TelegramSender;
  private readonly allowed: Set<number>;
  private readonly chunkSize: number;
  /** Numeric ids dropped by the gate (for diagnostics; never any content). */
  readonly droppedUserIds: string[] = [];

  constructor(kernel: AmritaKernel, sender: TelegramSender, opts: TelegramChannelOptions) {
    this.kernel = kernel;
    this.sender = sender;
    this.allowed = new Set(opts.allowedUserIds);
    this.chunkSize = opts.chunkSize ?? TELEGRAM_MAX;
  }

  async handleUpdate(update: InboundUpdate): Promise<ChannelResult> {
    // Owner gate — deny-by-default, applies to messages AND callbacks.
    if (!this.allowed.has(Number(update.userId))) {
      this.droppedUserIds.push(update.userId);
      return { channel: 'telegram', handled: false, outcome: 'denied', replies: [] };
    }

    const code = parsePairCommand(update.text);
    if (code) {
      try {
        const link = this.kernel.consumePairing({
          channel: 'telegram',
          code,
          externalUserId: update.userId,
        });
        const reply = `paired to project ${link.projectId}`;
        await this.send(update.chatId, [reply]);
        return {
          channel: 'telegram',
          handled: true,
          outcome: 'paired',
          ...(link.conversationId ? { conversationId: link.conversationId } : {}),
          replies: [reply],
        };
      } catch (e) {
        const reply = `pairing failed: ${safeMessage(e)}`;
        await this.send(update.chatId, [reply]);
        return {
          channel: 'telegram',
          handled: false,
          outcome: 'error',
          replies: [reply],
          error: safeMessage(e),
        };
      }
    }

    const link = this.kernel.getChannelLink('telegram', update.userId);
    if (!link?.conversationId) {
      const reply = 'not linked yet — send: /pair <code>';
      await this.send(update.chatId, [reply]);
      return { channel: 'telegram', handled: true, outcome: 'unpaired', replies: [reply] };
    }

    // Operator commands (ADR-0021): paired owners supervise from the phone.
    if (update.text.trim().startsWith('/')) {
      const reply = await this.runOperatorCommand(update.text.trim(), link.projectId);
      await this.send(update.chatId, chunkText(reply, this.chunkSize));
      return {
        channel: 'telegram',
        handled: true,
        outcome: 'command',
        conversationId: link.conversationId,
        replies: [reply],
      };
    }

    try {
      const turn = await this.kernel.runChatTurn({
        conversationId: link.conversationId,
        text: update.text,
        channel: 'telegram',
      });
      const chunks = chunkText(turn.text ?? '(no reply)', this.chunkSize);
      await this.send(update.chatId, chunks);
      return {
        channel: 'telegram',
        handled: true,
        outcome: 'replied',
        conversationId: link.conversationId,
        replies: chunks,
      };
    } catch (e) {
      const reply = `error: ${safeMessage(e)}`;
      await this.send(update.chatId, [reply]);
      return {
        channel: 'telegram',
        handled: false,
        outcome: 'error',
        replies: [reply],
        error: safeMessage(e),
      };
    }
  }

  /**
   * Owner operator commands. Everything reads/writes through the kernel's
   * typed surface; replies are plain text, value-free, and never carry secrets.
   */
  private async runOperatorCommand(text: string, projectId: string): Promise<string> {
    const [cmd, ...args] = text.split(/\s+/);
    switch ((cmd ?? '').toLowerCase()) {
      case '/status': {
        const c = this.kernel.getCompanion(projectId);
        const tasks = this.kernel.listTasks({ projectId });
        const openTasks = tasks.filter((t) => t.status !== 'done' && t.status !== 'dropped');
        const openQ = c.questions.filter((q) => q.status === 'open');
        const openR = c.risks.filter((r) => r.status === 'open');
        const active = this.kernel
          .listLanes({ projectId })
          .filter(
            (l) => l.status === 'spawned' || l.status === 'running' || l.status === 'merging',
          );
        const pending = this.kernel.listPendingApprovals().filter((a) => a.projectId === projectId);
        return [
          c.brief ? `goal: ${c.brief.goal}` : 'no brief yet',
          `tasks: ${openTasks.length} open / ${tasks.length} total`,
          `questions: ${openQ.length} open · risks: ${openR.length} open`,
          `lanes: ${active.length} active · approvals: ${pending.length} pending`,
          ...(pending.length > 0 ? ['→ /approvals to review'] : []),
        ].join('\n');
      }
      case '/lanes': {
        const lanes = this.kernel.listLanes({ projectId }).slice(-5).reverse();
        if (lanes.length === 0) return 'no lanes yet';
        return lanes
          .map((l) => {
            let goal = '';
            try {
              goal = (JSON.parse(l.mandateJson) as { goal?: string }).goal ?? '';
            } catch {
              goal = '';
            }
            return `[${l.status}] ${l.id.slice(0, 8)} ${goal.slice(0, 60)}`;
          })
          .join('\n');
      }
      case '/approvals': {
        const pending = this.kernel.listPendingApprovals().filter((a) => a.projectId === projectId);
        if (pending.length === 0) return 'no pending approvals';
        return pending
          .map(
            (a) =>
              `${a.approvalId.slice(0, 8)} · ${a.action}${a.detail ? ` · ${a.detail.slice(0, 80)}` : ''}`,
          )
          .concat('reply: /approve <id> or /deny <id>')
          .join('\n');
      }
      case '/approve':
      case '/deny': {
        const prefix = args[0];
        if (!prefix) return `usage: ${cmd} <approval id prefix>`;
        const match = this.kernel
          .listPendingApprovals()
          .filter(
            (a) => a.projectId === projectId && a.approvalId.startsWith(prefix.toUpperCase()),
          );
        if (match.length === 0) return `no pending approval matches "${prefix}"`;
        if (match.length > 1)
          return `"${prefix}" is ambiguous (${match.length} matches) — use more characters`;
        const first = match[0];
        if (!first) return `no pending approval matches "${prefix}"`;
        const decision = cmd?.toLowerCase() === '/approve' ? 'allow' : 'deny';
        this.kernel.resolveApproval(first.approvalId, decision);
        return `${decision === 'allow' ? 'approved' : 'denied'} ${first.approvalId.slice(0, 8)} · ${first.action}`;
      }
      case '/stop': {
        const prefix = args[0];
        if (!prefix) return 'usage: /stop <lane id prefix>';
        const lanes = this.kernel
          .listLanes({ projectId })
          .filter(
            (l) =>
              l.id.startsWith(prefix.toUpperCase()) &&
              (l.status === 'spawned' || l.status === 'running' || l.status === 'merging'),
          );
        if (lanes.length === 0) return `no active lane matches "${prefix}"`;
        if (lanes.length > 1) return `"${prefix}" is ambiguous (${lanes.length} matches)`;
        const lane = lanes[0];
        if (!lane) return `no active lane matches "${prefix}"`;
        const r = await this.kernel.cancelLane(lane.id);
        return r.cancelled
          ? `stopped lane ${lane.id.slice(0, 8)}`
          : `lane ${lane.id.slice(0, 8)} was not active`;
      }
      case '/help':
        return [
          '/status — project at a glance',
          '/lanes — recent lanes',
          '/approvals — pending operator approvals',
          '/approve <id> · /deny <id>',
          '/stop <lane id> — cancel an active lane',
          'anything else — chat with Amrita',
        ].join('\n');
      default:
        return `unknown command ${cmd} — try /help`;
    }
  }

  /** Send chunks in order (await each so Telegram message order is preserved). */
  private async send(chatId: string, chunks: string[]): Promise<void> {
    for (const c of chunks) {
      await this.sender.sendMessage(chatId, c);
    }
  }
}
