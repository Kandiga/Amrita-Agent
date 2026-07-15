/**
 * The Scribe (ADR-0044) — the agent→domain bridge.
 *
 * Amrita's chat agent has no tools (`ChatProvider` is `generate`/`generateStream`
 * and nothing else) and the daemon has no tool-dispatch path. So after a turn,
 * the Scribe re-reads the exchange and normalizes what BECAME TRUE into typed
 * proposals. It is the thing that finally connects a conversation to the project
 * store — the reason 298 live events had produced zero tasks.
 *
 * Hard rules, each of them tested:
 *
 * 1. **It runs OFF the reply path.** The user's turn has already been answered
 *    and persisted before the Scribe is invoked. It can never add latency to a
 *    reply, and a Scribe failure can never fail a turn. (This matters more than
 *    it looks: the live `fast` role resolves to the Claude Code CLI — a
 *    subprocess — so a Scribe pass is a process spawn, not a cheap API call.)
 *
 * 2. **It proposes; it does not decide.** Everything that ASSERTS something — a
 *    task someone must do, a risk that shapes the plan, a decision of record —
 *    goes to the Inbox for a human. The ONE exception is `question.opened`, which
 *    auto-commits: an open question is inert (it asserts nothing), maximally
 *    reversible, and it is what the one-question-at-a-time interview produces
 *    constantly. Guarded by a per-turn cap, dedup, and a kill-switch.
 *
 * 3. **A malformed proposal is DROPPED, never guessed at.** The model's output is
 *    parsed by a strict Zod schema. No repair, no coercion, no "best effort".
 *
 * 4. **It emits no domain event other than `question.opened`.** A test asserts
 *    this over the whole event log — it is the executable form of the boundary.
 */
import { type InboxKind, type RiskSeverity, riskSeveritySchema } from '@amrita/protocol';
import { z } from 'zod';

/** Kill-switches. Both default ON; either one reverts a slice of the behavior. */
export const SCRIBE_SETTING = 'scribe.enabled';
export const SCRIBE_AUTO_OPEN_QUESTIONS_SETTING = 'scribe.autoOpenQuestions';

/** At most this many questions may be auto-opened by ONE turn. */
export const MAX_AUTO_QUESTIONS_PER_TURN = 3;

/** Beyond this many open questions, auto-open stops and everything queues instead. */
export const MAX_OPEN_QUESTIONS = 25;

// ── the proposal contract ────────────────────────────────────────────────────
// Strict: an unknown key or a missing field means the proposal is dropped.

const taskProposalSchema = z
  .object({
    kind: z.literal('task'),
    title: z.string().min(1).max(300),
    body: z.string().max(2000).optional(),
    rationale: z.string().min(1).max(1000),
    confidence: z.enum(['low', 'medium', 'high']),
  })
  .strict();

const decisionProposalSchema = z
  .object({
    kind: z.literal('decision'),
    text: z.string().min(1).max(2000),
    rationale: z.string().min(1).max(1000),
    confidence: z.enum(['low', 'medium', 'high']),
  })
  .strict();

const riskProposalSchema = z
  .object({
    kind: z.literal('risk'),
    text: z.string().min(1).max(2000),
    severity: riskSeveritySchema.optional(),
    rationale: z.string().min(1).max(1000),
    confidence: z.enum(['low', 'medium', 'high']),
  })
  .strict();

const questionProposalSchema = z
  .object({
    kind: z.literal('question'),
    text: z.string().min(1).max(2000),
    rationale: z.string().min(1).max(1000),
    confidence: z.enum(['low', 'medium', 'high']),
  })
  .strict();

const milestoneProposalSchema = z
  .object({
    kind: z.literal('milestone'),
    title: z.string().min(1).max(300),
    targetDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    rationale: z.string().min(1).max(1000),
    confidence: z.enum(['low', 'medium', 'high']),
  })
  .strict();

const memoryProposalSchema = z
  .object({
    kind: z.literal('memory'),
    content: z.string().min(1).max(2000),
    rationale: z.string().min(1).max(1000),
    confidence: z.enum(['low', 'medium', 'high']),
  })
  .strict();

export const scribeProposalSchema = z.discriminatedUnion('kind', [
  taskProposalSchema,
  decisionProposalSchema,
  riskProposalSchema,
  questionProposalSchema,
  milestoneProposalSchema,
  memoryProposalSchema,
]);
export type ScribeProposal = z.infer<typeof scribeProposalSchema>;

/** The whole response. `proposals: []` is the correct, common answer. */
export const scribeResponseSchema = z
  .object({ proposals: z.array(scribeProposalSchema).max(10) })
  .strict();

/**
 * Parse a model response into proposals. Tolerant about the WRAPPER (models fence
 * JSON in ```json blocks and add prose), strict about the CONTENT.
 *
 * Returns `[]` on anything it cannot parse — never throws, never guesses. A
 * Scribe that cannot understand itself must produce nothing, not garbage.
 */
export function parseScribeResponse(text: string): ScribeProposal[] {
  const candidates: string[] = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) candidates.push(fenced[1]);
  // A bare object: take the outermost braces.
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));

  for (const c of candidates) {
    let raw: unknown;
    try {
      raw = JSON.parse(c);
    } catch {
      continue;
    }
    const parsed = scribeResponseSchema.safeParse(raw);
    if (parsed.success) return parsed.data.proposals;

    // The envelope was right but some proposals were not: keep the good ones
    // rather than losing a whole turn's work to one bad item. Each survivor is
    // still fully validated — this is salvage, not repair.
    const loose = z.object({ proposals: z.array(z.unknown()) }).safeParse(raw);
    if (loose.success) {
      const good: ScribeProposal[] = [];
      for (const p of loose.data.proposals) {
        const one = scribeProposalSchema.safeParse(p);
        if (one.success) good.push(one.data);
      }
      if (good.length > 0) return good;
    }
  }
  return [];
}

/** Map a proposal to the Inbox `suggested` payload for its target command. */
export function suggestedPayload(p: ScribeProposal): {
  kind: InboxKind;
  text: string;
  suggested: Record<string, unknown>;
} {
  switch (p.kind) {
    case 'task':
      return {
        kind: 'task',
        text: p.title,
        suggested: { title: p.title, ...(p.body ? { body: p.body } : {}) },
      };
    case 'decision':
      return { kind: 'decision', text: p.text, suggested: { text: p.text } };
    case 'risk':
      return {
        kind: 'risk',
        text: p.text,
        suggested: { text: p.text, ...(p.severity ? { severity: p.severity } : {}) },
      };
    case 'question':
      return { kind: 'question', text: p.text, suggested: { text: p.text } };
    case 'milestone':
      return {
        kind: 'milestone',
        text: p.title,
        suggested: {
          title: p.title,
          ...(p.targetDate ? { targetDate: p.targetDate } : {}),
        },
      };
    case 'memory':
      return { kind: 'memory', text: p.content, suggested: { content: p.content } };
  }
}

/**
 * Does this exchange plausibly contain project truth?
 *
 * This gate is NOT an optimization — it is required. The `fast` role resolves to
 * a CLI subprocess on the live host, so running the Scribe on every "thanks!" is
 * a process spawn for nothing. Cheap, deterministic, and deliberately generous:
 * a false positive costs one cheap call, a false negative loses a fact.
 */
export function looksLikeProjectTruth(userText: string, agentText: string): boolean {
  const haystack = `${userText}\n${agentText}`.toLowerCase();
  if (haystack.length < 40) return false;
  const signals = [
    // commitments and work
    'will ',
    'need to',
    'should ',
    'must ',
    'let’s',
    "let's",
    'todo',
    'task',
    'deadline',
    'due ',
    'by friday',
    'next week',
    // decisions
    'decide',
    'decision',
    'we chose',
    'going with',
    'instead of',
    // risk / doubt
    'risk',
    'worried',
    'might not',
    'blocker',
    'blocked',
    'depends on',
    // open questions
    '?',
    'unclear',
    'unknown',
    'find out',
    // dates and money are almost always project truth
    'budget',
    '$',
    'cost',
  ];
  return signals.some((s) => haystack.includes(s));
}

/** The Scribe's instruction. Deliberately narrow: extract, do not invent. */
export function buildScribePrompt(input: {
  contextPack: string;
  userText: string;
  agentText: string;
}): string {
  return [
    'You are the Scribe for a project management system. You do not talk to anyone.',
    'Your only job is to read the exchange below and report what BECAME TRUE about',
    'the project, as typed proposals.',
    '',
    input.contextPack
      ? `Here is the project's current state, so you do not re-propose what is already known:\n\n${input.contextPack}`
      : 'This project has no recorded state yet.',
    '',
    '--- the exchange ---',
    `Operator: ${input.userText}`,
    `Amrita: ${input.agentText}`,
    '--- end ---',
    '',
    'Rules:',
    '- Report ONLY what the exchange actually establishes. Do not infer, do not invent,',
    '  do not restate something already in the project state above.',
    '- If nothing became true, return {"proposals": []}. That is the common, correct answer.',
    '- A "question" is something genuinely unresolved that someone must answer.',
    '- A "risk" is something that could break the project.',
    '- A "decision" is a choice that was actually made, not one being considered.',
    '- `rationale` must quote or closely paraphrase what in the exchange justifies the proposal.',
    '- `confidence` is how sure you are that this is real project truth.',
    '',
    'Reply with JSON only, in exactly this shape:',
    '{"proposals":[{"kind":"task","title":"…","rationale":"…","confidence":"high"}]}',
    '',
    'Valid kinds: task, decision, risk, question, milestone, memory.',
    'Fields by kind: task{title,body?}, decision{text}, risk{text,severity?},',
    'question{text}, milestone{title,targetDate?}, memory{content}.',
    'Every proposal also needs `rationale` and `confidence` (low|medium|high).',
  ].join('\n');
}

/** Normalize a question for dedup — so the Scribe cannot re-open what is open. */
export function questionKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9֐-׿ ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export type { RiskSeverity };
