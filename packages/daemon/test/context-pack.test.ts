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
import { describe, expect, it } from 'vitest';
import { auditCharter } from '../src/charter-audit.ts';
import { type ProjectContextPackInput, buildProjectContextPack } from '../src/context-pack.ts';

const TS = '2026-07-14T10:00:00.000Z';

function input(over: Partial<ProjectContextPackInput> = {}): ProjectContextPackInput {
  return {
    project: { name: 'Unity Festival' },
    brief: null,
    tasks: [],
    milestones: [],
    questions: [],
    risks: [],
    decisions: [],
    memory: [],
    gaps: [],
    sources: [],
    context: null,
    ...over,
  };
}

function brief(over: Partial<ProjectBriefRow> = {}): ProjectBriefRow {
  return {
    projectId: 'p1',
    goal: 'Run the Unity Festival',
    audience: 'the town',
    successCriteria: ['500 attendees'],
    scope: ['the event'],
    noScope: ['a second stage'],
    finishLine: null,
    constraints: [],
    decisionRights: [],
    certainty: {},
    version: 0,
    sourceMessageId: null,
    createdAt: TS,
    updatedAt: TS,
    ...over,
  } as ProjectBriefRow;
}

function task(over: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 't1',
    projectId: 'p1',
    conversationId: null,
    sourceMessageId: null,
    laneId: null,
    milestoneId: null,
    status: 'now',
    title: 'File the permit',
    body: null,
    externalRef: null,
    createdAt: TS,
    updatedAt: TS,
    ...over,
  } as TaskRow;
}

function risk(over: Partial<RiskRow> = {}): RiskRow {
  return {
    id: 'r1',
    projectId: 'p1',
    conversationId: null,
    sourceMessageId: null,
    text: 'rain on the day',
    severity: 'high',
    status: 'open',
    resolution: null,
    resolvedByDecisionId: null,
    dropReason: null,
    createdAt: TS,
    updatedAt: TS,
    ...over,
  } as RiskRow;
}

function question(over: Partial<OpenQuestionRow> = {}): OpenQuestionRow {
  return {
    id: 'q1',
    projectId: 'p1',
    conversationId: null,
    sourceMessageId: null,
    text: 'who signs the permit?',
    status: 'open',
    resolution: null,
    resolvedByDecisionId: null,
    dropReason: null,
    createdAt: TS,
    updatedAt: TS,
    ...over,
  } as OpenQuestionRow;
}

function milestone(over: Partial<MilestoneRow> = {}): MilestoneRow {
  return {
    id: 'm1',
    projectId: 'p1',
    title: 'Permits secured',
    description: null,
    status: 'active',
    targetDate: '2026-09-01',
    createdAt: TS,
    updatedAt: TS,
    ...over,
  } as MilestoneRow;
}

function decision(text: string, id = 'd1'): DecisionRow {
  return {
    id,
    projectId: 'p1',
    conversationId: null,
    sourceMessageId: null,
    supersedesId: null,
    text,
    createdAt: TS,
  } as DecisionRow;
}

function memory(content: string, id = 'mem1'): MemoryEntryRow {
  return {
    id,
    scope: 'project',
    projectId: 'p1',
    content,
    charCount: content.length,
    source: 'chat',
    sourceMessageId: null,
    createdAt: TS,
    updatedAt: TS,
  } as MemoryEntryRow;
}

describe('project context pack (ADR-0044)', () => {
  it('is EMPTY for a brand-new project — no skeleton of empty headings', () => {
    expect(buildProjectContextPack(input())).toBe('');
  });

  it('renders the charter, so Amrita never asks for the goal she already has', () => {
    const out = buildProjectContextPack(input({ brief: brief() }));
    expect(out).toContain('# Project: Unity Festival');
    expect(out).toContain('Goal: Run the Unity Festival');
    expect(out).toContain('Success: 500 attendees');
    expect(out).toContain('NOT in scope: a second stage');
  });

  it('says so honestly when there is no brief', () => {
    const out = buildProjectContextPack(input({ tasks: [task()] }));
    expect(out).toContain('No brief yet');
  });

  // ── the charter: "constraints as fuel" (ADR-0044 / slice 3) ────────────────

  it('renders the finish line, the constraints, and who approves what', () => {
    const out = buildProjectContextPack(
      input({
        brief: brief({
          finishLine: 'the festival happens and books at $15K net',
          constraints: [
            { kind: 'budget', text: '$15K net, no overrun', hard: true },
            { kind: 'date', text: 'third Saturday of October', hard: true },
            { kind: 'resource', text: 'one full-time organizer', hard: false },
          ],
          decisionRights: [
            { area: 'vendor list', approver: 'the arts council' },
            { area: 'spend over $1K', approver: 'Casey' },
          ],
        }),
      }),
    );
    expect(out).toContain('Done means: the festival happens and books at $15K net');
    // the fixed-vs-negotiable boundary must survive to the model verbatim
    expect(out).toContain('Constraint (budget, HARD — not negotiable): $15K net, no overrun');
    expect(out).toContain('Constraint (resource, negotiable): one full-time organizer');
    expect(out).toContain('Decision right: vendor list → approved by the arts council');
  });

  it('carries the COMPUTED critique, and tells her to interview one question at a time', () => {
    // ADR-0045: the findings are computed by `auditCharter`, not hoped for in a
    // prompt — the pack just states them.
    const out = buildProjectContextPack(
      input({
        brief: brief(),
        charterFindings: auditCharter({
          // a budget exists but nobody may approve it, and there is no finish line
          brief: brief({
            finishLine: null,
            constraints: [{ kind: 'budget', text: '15K net', hard: true }],
            decisionRights: [],
          }),
          tasks: [],
          risks: [],
          questions: [],
        }),
      }),
    );
    expect(out).toContain('Charter findings');
    expect(out).toContain('[MISSING · high] finishLine');
    expect(out).toContain('nobody is authorised'); // the missing-approver finding
    expect(out).toContain('Ask ONE high-value question at a time');
    expect(out).toContain('Do not present a form');
    expect(out).toContain('never restate it as fact'); // the hypothesis rule
    expect(out).toContain('most likely to break this project');
  });

  it('says nothing about the charter once it is complete and confirmed', () => {
    const complete = brief({
      finishLine: 'it ships',
      constraints: [{ kind: 'budget', text: '$15K', hard: true }],
      decisionRights: [{ area: 'spend', approver: 'Casey' }],
    });
    const out = buildProjectContextPack(
      input({
        brief: complete,
        charterFindings: auditCharter({ brief: complete, tasks: [], risks: [], questions: [] }),
      }),
    );
    expect(out).not.toContain('Charter findings');
  });

  it('marks an INFERRED charter field as a hypothesis, never as something you said', () => {
    const guessed = brief({ certainty: { finishLine: 'inferred' } });
    const out = buildProjectContextPack(
      input({
        brief: guessed,
        charterFindings: auditCharter({ brief: guessed, tasks: [], risks: [], questions: [] }),
      }),
    );
    expect(out).toContain('[UNCONFIRMED · high] finishLine');
    expect(out).toContain('hypothesis, not a fact');
  });

  it('carries open risks and questions, and omits settled ones', () => {
    const out = buildProjectContextPack(
      input({
        risks: [risk(), risk({ id: 'r2', text: 'vendor bailed', status: 'resolved' })],
        questions: [
          question(),
          question({ id: 'q2', text: 'insurance?', status: 'dropped', dropReason: 'n/a' }),
        ],
      }),
    );
    expect(out).toContain('[high] rain on the day');
    expect(out).not.toContain('vendor bailed'); // resolved → not in flight
    expect(out).toContain('who signs the permit?');
    expect(out).not.toContain('insurance?'); // dropped → not in flight
  });

  it('separates open tasks from done ones', () => {
    const out = buildProjectContextPack(
      input({
        tasks: [
          task(),
          task({ id: 't2', title: 'Book the band', status: 'done' }),
          task({ id: 't3', title: 'Order tents', status: 'later' }),
        ],
      }),
    );
    expect(out).toContain('[now] File the permit');
    expect(out).toContain('[later] Order tents');
    expect(out).toContain('(1 done)');
    expect(out).not.toContain('[done] Book the band');
  });

  it('shows milestones with their target dates', () => {
    const out = buildProjectContextPack(input({ milestones: [milestone()] }));
    expect(out).toContain('[active] Permits secured — due 2026-09-01');
  });

  it('is HONEST about connectors — it never lets her claim an unbuilt one', () => {
    const sources: KnowledgeSource[] = [
      { id: 'chat', kind: 'chat', title: 'Chat', status: 'manual', extracts: [], detail: 'x' },
      { id: 'email', kind: 'email', title: 'Email', status: 'planned', extracts: [], detail: 'y' },
    ];
    const out = buildProjectContextPack(input({ brief: brief(), sources }));
    expect(out).toContain('No source is connected');
    expect(out).toContain('email (planned)');
    expect(out).toContain('Do not claim these ingest anything');
  });

  it('reports the working tree only when a root is really configured (ADR-0034)', () => {
    const configured: ProjectContextWire = {
      projectId: 'p1',
      configured: true,
      root: '/srv/x',
      exists: true,
      git: { isRepo: true, branch: 'main', dirtyCount: 2, lastCommit: 'abc123 fix things' },
      files: { totalFiles: 42, truncated: false, topDirs: [] },
    };
    expect(buildProjectContextPack(input({ brief: brief(), context: configured }))).toContain(
      'Git: branch main, 2 dirty',
    );

    // No root → no invented tree.
    const unconfigured: ProjectContextWire = {
      projectId: 'p1',
      configured: false,
      root: null,
      exists: false,
      git: null,
      files: null,
    };
    const out = buildProjectContextPack(input({ brief: brief(), context: unconfigured }));
    expect(out).not.toContain('Working tree');
  });

  it('surfaces the knowledge gaps the harness already detects', () => {
    const gaps: KnowledgeGap[] = [
      { kind: 'missing-owner', severity: 'medium', detail: 'task t1 has no owner' },
    ] as KnowledgeGap[];
    expect(buildProjectContextPack(input({ brief: brief(), gaps }))).toContain('missing-owner');
  });

  it('NEVER exceeds maxChars, and says what it dropped', () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      memory(`a very long memory entry number ${i} `.repeat(10), `mem${i}`),
    );
    const out = buildProjectContextPack(input({ brief: brief(), memory: many }), {
      maxChars: 900,
    });
    expect(out.length).toBeLessThanOrEqual(900 + 80); // + the "omitted" note
    expect(out).toContain('Goal: Run the Unity Festival'); // charter survives truncation
    expect(out).toContain('omitted to stay within the context budget');
  });

  it('caps a runaway section instead of dumping the database', () => {
    const many = Array.from({ length: 50 }, (_, i) => task({ id: `t${i}`, title: `task ${i}` }));
    const out = buildProjectContextPack(input({ tasks: many }));
    expect(out).toContain('(+38 more)'); // 50 open tasks, cap 12
  });

  it('is DETERMINISTIC — same input, byte-identical output (no clock, no randomness)', () => {
    const i = input({ brief: brief(), tasks: [task()], risks: [risk()] });
    expect(buildProjectContextPack(i)).toBe(buildProjectContextPack(i));
  });

  it('leaks no secret-shaped token (the store holds env NAMES only, ADR-0008)', () => {
    const out = buildProjectContextPack(
      input({
        brief: brief(),
        memory: [memory('the API key is stored in ANTHROPIC_API_KEY')],
        tasks: [task()],
        risks: [risk()],
      }),
    );
    // Nothing that looks like a real credential value may appear.
    expect(out).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
    expect(out).not.toMatch(/\bBearer\s+[A-Za-z0-9._-]{16,}/);
    // An env NAME is not a secret and is allowed to be discussed.
    expect(out).toContain('ANTHROPIC_API_KEY');
  });
});
