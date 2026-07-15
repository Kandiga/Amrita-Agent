/**
 * The Project Context Pack (ADR-0044) — what Amrita knows about the project she
 * is in, rendered as ONE bounded system message.
 *
 * Until this module existed, the chat turn sent the model NOTHING but the raw
 * conversation transcript (kernel.ts: `listMessages().map(...)`). No brief, no
 * tasks, no risks, no decisions, no memory. The "project-aware agent OS" was, at
 * the chat layer, not project-aware — which is why the live DB held 7 projects
 * and 298 events but zero tasks, milestones, risks or questions.
 *
 * Design rules, all load-bearing:
 *
 * - **Pure.** Every input is injected. No store, no clock, no filesystem, no
 *   network — so it is exhaustively unit-testable and deterministic.
 * - **Bounded.** `maxChars` is a hard ceiling. Sections are emitted in priority
 *   order and each one degrades to `(+N more)` rather than blowing the budget.
 *   The charter, open risks and open questions are never dropped — they are the
 *   things that change what a good answer looks like.
 * - **Secret-free by construction.** It reads only domain rows. The store never
 *   holds a secret value (env NAMES only, ADR-0008), so no redaction is needed —
 *   and a test asserts no secret-shaped key can appear.
 * - **Honest.** Unknowns are stated as unknowns ("no brief yet"), and connector
 *   status is reported as `connected | manual | planned` (ADR-0027) so the model
 *   can never claim an email connector that does not exist.
 *
 * There is deliberately NO cache and NO invalidation: the pack is rebuilt from
 * live state at the start of every turn, so any committed event is visible to
 * the next turn by construction. That is what makes "drag a card and Amrita just
 * knows" true without a second chat message.
 *
 * NOTE the name. `contextPackSchema` in @amrita/protocol is the LANE mandate's
 * `{memory, files, decisions}` bundle — a different thing entirely. This is the
 * chat-turn pack and is always spelled `ProjectContextPack`.
 */
import type { KnowledgeGap, KnowledgeSource, ProjectContextWire } from '@amrita/protocol';
import type {
  DecisionRow,
  MemoryEntryRow,
  MilestoneRow,
  OpenQuestionRow,
  ProjectBriefRow,
  RiskRow,
  TaskRow,
} from '@amrita/store';
import type { CharterFinding } from './charter-audit.ts';

/**
 * Kill-switch. Set to `false` and a chat turn degrades to exactly the old
 * behavior (transcript only) — no code path changes, nothing to roll back.
 */
export const CONTEXT_PACK_SETTING = 'context.pack.enabled';

/**
 * Amrita's always-on capability preamble (CANVAS-1). Injected on every project
 * turn, even a stateless one, because the LIVE CANVAS is a property of Amrita,
 * not of any project — without it the model builds files on disk and reaches for
 * `python -m http.server`, which never reaches the canvas the operator is looking
 * at. Kept tiny so it barely dents the budget.
 */
export const AMRITA_CAPABILITIES = [
  '# Amrita — the live canvas',
  '',
  'You have a LIVE CANVAS in the app. When the operator asks you to build or show',
  'anything visual or interactive — a page, a game, a widget, a mockup, a chart, a',
  'diagram — return the COMPLETE, self-contained HTML inside a ```html code block in',
  'your reply. It renders live on the canvas as you stream, and the operator watches',
  'it take shape before you finish.',
  '',
  'The canvas is a sandbox with NO network and NO filesystem, so:',
  '- Put everything in ONE document per block: inline <style> and inline <script>',
  '  only. No external URLs, CDNs, web fonts, or fetch() — they are blocked and fail.',
  '- Keep each block under 256 KB. Give each a descriptive <title> — it becomes the',
  '  card label on the canvas.',
  '- Do NOT write files to disk or start a web server (e.g. python -m http.server) to',
  '  preview — the canvas IS the preview. Just put the HTML in the ```html block.',
  '',
  'MULTIPLE builds at once: for a multi-page site or several design variations, emit',
  'ONE ```html block PER page/variation, each with its own distinct <title> (e.g.',
  '"Home", "Pricing", "Variation A"). Each becomes its own movable card on the canvas.',
  '',
  'MODIFYING a build: if the context says the operator SELECTED a build on the canvas,',
  'their instruction is about THAT one — return the COMPLETE updated HTML for it (same',
  '<title>) in a ```html block, and it re-renders in place.',
].join('\n');

/** Default ceiling for the rendered pack. Roughly 1.5k tokens. */
const DEFAULT_MAX_CHARS = 6000;

/** Per-section item caps — the pack is a briefing, not a database dump. */
const CAPS = {
  tasks: 12,
  milestones: 6,
  questions: 8,
  risks: 8,
  decisions: 6,
  memory: 6,
  gaps: 5,
} as const;

export interface ProjectContextPackInput {
  project: { name: string };
  brief: ProjectBriefRow | null;
  /** The deterministic critique (ADR-0045) — computed, not hoped for. */
  charterFindings?: CharterFinding[];
  tasks: TaskRow[];
  milestones: MilestoneRow[];
  questions: OpenQuestionRow[];
  risks: RiskRow[];
  decisions: DecisionRow[];
  memory: MemoryEntryRow[];
  gaps: KnowledgeGap[];
  sources: KnowledgeSource[];
  context: ProjectContextWire | null;
}

export interface ProjectContextPackOptions {
  maxChars?: number;
}

/** Collapse whitespace and hard-cap a single line so one long row cannot dominate. */
function line(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Render up to `cap` items, honestly reporting what was left out. */
function bullets<T>(items: readonly T[], cap: number, render: (item: T) => string): string[] {
  const shown = items.slice(0, cap).map((i) => `- ${render(i)}`);
  if (items.length > cap) shown.push(`- (+${items.length - cap} more)`);
  return shown;
}

function isOpenTask(t: TaskRow): boolean {
  return t.status === 'now' || t.status === 'later';
}

/**
 * Build the pack. Returns an empty string when there is genuinely nothing to say
 * (a brand-new project with no state) — the caller then sends no system message
 * at all, rather than a block of headings with nothing under them.
 */
export function buildProjectContextPack(
  input: ProjectContextPackInput,
  opts: ProjectContextPackOptions = {},
): string {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;

  // Sections in PRIORITY order. Everything below the budget line is dropped
  // whole, so the order IS the truncation policy: charter and open risks/
  // questions come before decisions, memory and the working tree.
  const sections: { title: string; lines: string[] }[] = [];

  // 1. Charter — what the project is for, and what it must live within.
  if (input.brief) {
    const b = input.brief;
    const charter: string[] = [`- Goal: ${line(b.goal, 300)}`];
    if (b.finishLine) charter.push(`- Done means: ${line(b.finishLine, 300)}`);
    if (b.audience) charter.push(`- Audience: ${line(b.audience)}`);
    for (const c of b.successCriteria) charter.push(`- Success: ${line(c)}`);
    // Constraints are the fuel of the method: they are what makes a plan
    // accountable, and the `hard` flag is the fixed-vs-negotiable boundary.
    for (const c of b.constraints) {
      charter.push(
        `- Constraint (${c.kind}, ${c.hard ? 'HARD — not negotiable' : 'negotiable'}): ${line(c.text)}`,
      );
    }
    for (const d of b.decisionRights) {
      charter.push(`- Decision right: ${line(d.area, 80)} → approved by ${line(d.approver, 60)}`);
    }
    for (const s of b.scope) charter.push(`- In scope: ${line(s)}`);
    for (const s of b.noScope) charter.push(`- NOT in scope: ${line(s)}`);
    sections.push({ title: 'Charter', lines: charter });
  } else {
    sections.push({
      title: 'Charter',
      lines: ['- No brief yet. The goal, audience and success criteria are not captured.'],
    });
  }

  // 1b. The critique (ADR-0045). These findings are COMPUTED — a missing approver,
  // two conflicting hard dates, a guess sitting in the charter as though it were a
  // fact. A prompt can ask a model to notice a contradiction; it cannot guarantee
  // it. So the machine states them, and the model does the part only it can do:
  // judge which constraint is most likely to break the project, and say why.
  const findings = input.charterFindings ?? [];
  if (findings.length > 0) {
    sections.push({
      title: 'Charter findings — act on these',
      lines: [
        ...bullets(
          findings,
          8,
          (f) =>
            `[${f.kind.toUpperCase()} · ${f.severity}] ${f.field}: ${line(f.detail, 200)}${f.ask ? ` → ask: "${line(f.ask, 120)}"` : ''}`,
        ),
        '',
        '- Ask ONE high-value question at a time, say why it matters, and wait for the answer.',
        '- Do not present a form or a list of questions. Do not invent an answer.',
        '- An UNCONFIRMED item is a hypothesis you produced — never restate it as fact.',
        '- Name the single constraint most likely to break this project, and explain why.',
      ],
    });
  }

  // 2. Open risks — the things most likely to break the project.
  const openRisks = input.risks.filter((r) => r.status === 'open');
  if (openRisks.length > 0) {
    sections.push({
      title: 'Open risks',
      lines: bullets(openRisks, CAPS.risks, (r) =>
        r.severity ? `[${r.severity}] ${line(r.text)}` : line(r.text),
      ),
    });
  }

  // 3. Open questions — what is unresolved.
  const openQuestions = input.questions.filter((q) => q.status === 'open');
  if (openQuestions.length > 0) {
    sections.push({
      title: 'Open questions',
      lines: bullets(openQuestions, CAPS.questions, (q) => line(q.text)),
    });
  }

  // 4. Milestones.
  const liveMilestones = input.milestones.filter((m) => m.status !== 'dropped');
  if (liveMilestones.length > 0) {
    sections.push({
      title: 'Milestones',
      lines: bullets(liveMilestones, CAPS.milestones, (m) => {
        const due = m.targetDate ? ` — due ${m.targetDate}` : '';
        return `[${m.status}] ${line(m.title)}${due}`;
      }),
    });
  }

  // 5. Tasks in flight.
  const openTasks = input.tasks.filter(isOpenTask);
  const doneCount = input.tasks.filter((t) => t.status === 'done').length;
  if (input.tasks.length > 0) {
    const lines = bullets(openTasks, CAPS.tasks, (t) => `[${t.status}] ${line(t.title)}`);
    if (openTasks.length === 0) lines.push('- No open tasks.');
    if (doneCount > 0) lines.push(`- (${doneCount} done)`);
    sections.push({ title: 'Tasks', lines });
  }

  // 6. Recent decisions (newest first — the log is oldest-first).
  if (input.decisions.length > 0) {
    const newest = [...input.decisions].reverse();
    sections.push({
      title: 'Decisions',
      lines: bullets(newest, CAPS.decisions, (d) => line(d.text)),
    });
  }

  // 7. Project memory.
  if (input.memory.length > 0) {
    sections.push({
      title: 'Project memory',
      lines: bullets(input.memory, CAPS.memory, (m) => line(m.content)),
    });
  }

  // 8. The working tree — bounded, read-only (ADR-0034).
  if (input.context?.configured && input.context.exists) {
    const lines: string[] = [];
    const git = input.context.git;
    if (git?.isRepo) {
      const bits = [git.branch ? `branch ${git.branch}` : null, `${git.dirtyCount ?? 0} dirty`]
        .filter(Boolean)
        .join(', ');
      lines.push(`- Git: ${bits}`);
      if (git.lastCommit) lines.push(`- Last commit: ${line(git.lastCommit)}`);
    }
    if (input.context.files) lines.push(`- Files: ${input.context.files.totalFiles} tracked`);
    if (lines.length > 0) sections.push({ title: 'Working tree', lines });
  }

  // 9. Knowledge gaps — what the harness knows is missing.
  if (input.gaps.length > 0) {
    sections.push({
      title: 'Known gaps',
      lines: bullets(input.gaps, CAPS.gaps, (g) => `${g.kind}: ${line(g.detail)}`),
    });
  }

  // 10. Honest source status — so she can never claim a connector that is not real.
  const connected = input.sources.filter((s) => s.status === 'connected').map((s) => s.id);
  const notConnected = input.sources.filter((s) => s.status !== 'connected');
  if (input.sources.length > 0) {
    const lines = [
      connected.length > 0
        ? `- Connected sources: ${connected.join(', ')}`
        : '- No source is connected. Nothing is ingested automatically.',
    ];
    if (notConnected.length > 0) {
      lines.push(
        `- Not connected: ${notConnected.map((s) => `${s.id} (${s.status})`).join(', ')}. Do not claim these ingest anything.`,
      );
    }
    sections.push({ title: 'Sources', lines });
  }

  // Nothing worth saying: a brand-new project with no brief and no state. Emit
  // nothing rather than a skeleton of empty headings.
  const hasState =
    input.brief !== null ||
    input.tasks.length > 0 ||
    input.milestones.length > 0 ||
    openQuestions.length > 0 ||
    openRisks.length > 0 ||
    input.decisions.length > 0 ||
    input.memory.length > 0;
  if (!hasState) return '';

  const header = [
    `# Project: ${line(input.project.name, 80)}`,
    '',
    'This is the current, authoritative state of the project you are working on.',
    'It is regenerated from the project store at the start of every turn, so it is',
    'never stale. Use it instead of asking the operator to repeat what is already here.',
    'If something below is missing or wrong, say so plainly — do not invent it.',
  ];

  // Assemble under the budget. A section that does not fit is dropped WHOLE, so
  // the model never sees a half-truncated risk register and mistake it for all
  // of them; the note below tells it that happened.
  const out: string[] = [...header];
  let used = out.join('\n').length;
  let dropped = 0;
  for (const s of sections) {
    const block = `\n## ${s.title}\n${s.lines.join('\n')}`;
    if (used + block.length > maxChars) {
      dropped++;
      continue;
    }
    out.push(block);
    used += block.length;
  }
  if (dropped > 0) {
    out.push(`\n(${dropped} section(s) omitted to stay within the context budget.)`);
  }
  return out.join('\n');
}
