/**
 * The Organizational Brain Harness (ADR-0027) — daemon layer.
 *
 * The brain is a **deterministic projection** over event-sourced state plus
 * manually-captured memory (same pattern as the surface artifacts), not a new
 * store table. `buildProjectBrain` is pure: every input is injected so it is
 * fully testable. Sources/topology are honest — `connected` only where real
 * ingestion happens today; everything else is `manual`/`planned`.
 *
 * Strategy: docs/strategy/organizational-brain-harness.md
 */
import type {
  AmritaEvent,
  HarnessTopology,
  KnowledgeGap,
  KnowledgeRecord,
  KnowledgeSource,
  MaintenanceEvent,
  ProjectBrain,
} from '@amrita/protocol';
import type {
  DecisionRow,
  MemoryEntryRow,
  MilestoneRow,
  OpenQuestionRow,
  ProjectBriefRow,
  RiskRow,
  TaskRow,
} from '@amrita/store';

// ── harness topology (honest about what runs today) ──────────────────────────

export const HARNESS_TOPOLOGY: HarnessTopology = {
  version: 1,
  agents: [
    {
      id: 'capture',
      role: 'ingest',
      title: 'Manual capture agent',
      ingests: ['manual'],
      trigger: 'operator says "remember this for the project brain" (web/CLI/Telegram)',
      outputs: ['normalized knowledge record with provenance'],
      qualityChecks: ['has a source', 'has a title', 'no secret values'],
      status: 'active',
    },
    {
      id: 'cinema-extractor',
      role: 'ingest',
      title: 'Cinema module extractor',
      ingests: ['module'],
      maintains: ['project-context', 'decision'],
      trigger: 'Cinema digest sync + applied credit/destructive plans (module:cinema)',
      outputs: ['production-digest record with module provenance', 'cinema-tagged decisions'],
      qualityChecks: [
        'metadata only (no media bytes)',
        'stable slug per project (idempotent sync)',
      ],
      status: 'active',
    },
    {
      id: 'linker',
      role: 'link',
      title: 'Linking agent',
      maintains: ['decision', 'open-question', 'project-context'],
      trigger: 'every brain projection',
      outputs: ['[[links]] between related records', 'decision↔question and task↔milestone links'],
      qualityChecks: ['links resolve to existing records'],
      status: 'active',
    },
    {
      id: 'maintainer',
      role: 'maintain',
      title: 'Coherence / gap agent',
      maintains: ['decision', 'commitment', 'open-question', 'project-context'],
      trigger: 'every brain projection',
      outputs: ['gaps: missing owner/date/source, orphans, stale, contradictions, unresolved'],
      qualityChecks: ['gaps reference real records', 'contradictions are surfaced, not hidden'],
      status: 'active',
    },
    {
      id: 'chat-extractor',
      role: 'ingest',
      title: 'Chat extraction agent',
      ingests: ['chat'],
      trigger: 'planned — new messages on a connected channel (Telegram is live as transport)',
      outputs: ['commitments, informal decisions, working context from chat'],
      qualityChecks: ['owner + date resolved', 'provenance back to the message'],
      status: 'planned',
    },
    {
      id: 'mailbox-extractor',
      role: 'ingest',
      title: 'Email / calendar extraction agent',
      ingests: ['email', 'calendar'],
      trigger: 'planned — new threads / meetings',
      outputs: ['commitments, decisions, action items, meeting outcomes'],
      qualityChecks: ['owner + date resolved', 'provenance back to the thread/event'],
      status: 'planned',
    },
    {
      id: 'answerer',
      role: 'answer',
      title: 'Brain-cited answer agent',
      trigger: 'planned — operator asks a question',
      outputs: ['answers from maintained knowledge, with citations; retrieval kept distinct'],
      qualityChecks: ['every claim cites a record', 'retrieval ≠ maintained knowledge is explicit'],
      status: 'planned',
    },
  ],
};

// ── ingestion sources (honest base; the kernel enriches chat/repo live) ───────

/** The Cinema module as a knowledge source — `connected` ONLY when the project
 *  actually has cinema-synced data (ADR-0027 honesty carried over). */
export function cinemaKnowledgeSource(hasData: boolean): KnowledgeSource {
  return {
    id: 'module:cinema',
    kind: 'module',
    title: 'Cinema Studio module',
    status: hasData ? 'connected' : 'planned',
    detail: hasData
      ? 'Production digest + applied-plan decisions sync from the linked Cinema project (metadata only — media never crosses).'
      : 'Link a Cinema project (Cinema app → Settings → Amrita Platform → Link, then Sync) and its digest + decisions appear here.',
    extracts: ['production digest', 'applied plan decisions', 'format/style decisions'],
    ...(hasData ? {} : { nextStep: 'Cinema app → Settings → Amrita Platform → Link + Sync' }),
  };
}

export function baseKnowledgeSources(): KnowledgeSource[] {
  return [
    {
      id: 'manual',
      kind: 'manual',
      title: 'Manual capture',
      status: 'manual',
      detail: 'Tell Amrita "remember this for the project brain" — captured with provenance.',
      extracts: ['decisions', 'commitments', 'meeting notes', 'project context', 'entities'],
    },
    {
      id: 'chat',
      kind: 'chat',
      title: 'Chat (Telegram / Slack / Discord)',
      status: 'planned',
      detail:
        'The Telegram operator runner is live as transport, but automatic knowledge extraction is not built. Use manual capture for now.',
      extracts: ['informal decisions', 'commitments', 'working context'],
      nextStep: 'amrita setup  # channels section',
    },
    {
      id: 'repo',
      kind: 'repo',
      title: 'Repos / issues (GitHub)',
      status: 'manual',
      detail:
        'GitHub issues import one-way into tasks; durable references appear as source-excerpt records. Auto-extraction of decisions is not built.',
      extracts: ['durable references', 'project truth'],
      nextStep: 'amrita github import --project <slug> --repo <owner/repo>',
    },
    {
      id: 'email',
      kind: 'email',
      title: 'Email threads',
      status: 'planned',
      detail: 'Extraction of commitments/decisions/owners/dates from mail is planned.',
      extracts: ['commitments', 'decisions', 'blockers', 'owners', 'dates'],
    },
    {
      id: 'calendar',
      kind: 'calendar',
      title: 'Calendar / meetings',
      status: 'planned',
      detail: 'Meeting context, outcomes, and action items extraction is planned.',
      extracts: ['meeting context', 'outcomes', 'action items'],
    },
    {
      id: 'docs',
      kind: 'docs',
      title: 'Docs / files',
      status: 'planned',
      detail: 'Durable reference extraction from documents is planned.',
      extracts: ['durable references', 'project truth'],
    },
  ];
}

// ── pure projection helpers ──────────────────────────────────────────────────

const DEFAULT_STALE_DAYS = 90;

function dateOf(iso: string | null | undefined): string | null {
  return iso ? iso.slice(0, 10) : null;
}

function excerpt(text: string, max = 120): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function parseTags(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/#([a-z0-9][a-z0-9-]*)/gi)) {
    const tag = m[1];
    if (tag) out.add(tag.toLowerCase());
  }
  return [...out];
}

function parseOwner(text: string): string | null {
  const m = text.match(/@([a-z0-9][a-z0-9._-]*)/i);
  return m?.[1] ?? null;
}

function parseDueDate(text: string): string | null {
  const m =
    text.match(/\b(?:due|by|on)[:\s]+(\d{4}-\d{2}-\d{2})\b/i) ??
    text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  return m?.[1] ?? null;
}

/** Map a memory entry's free-form `source` to an honest source id. */
function sourceIdForMemory(source: string | null): string {
  const s = (source ?? '').toLowerCase();
  if (s.startsWith('module:')) return s.split(/\s/)[0] ?? 'module:cinema';
  // System Brain writes (ADR-0036) keep their exact provenance, e.g. system:audit.
  if (s.startsWith('system:')) return s.split(/\s/)[0] ?? 'system';
  if (
    s.startsWith('telegram') ||
    s.startsWith('chat') ||
    s.startsWith('session') ||
    s.startsWith('slack') ||
    s.startsWith('discord')
  )
    return 'chat';
  if (s.startsWith('github') || s.startsWith('repo')) return 'repo';
  if (s.startsWith('email') || s.startsWith('mail')) return 'email';
  if (s.startsWith('calendar') || s.startsWith('meeting')) return 'calendar';
  return 'manual';
}

interface MemoryKindParse {
  kind: KnowledgeRecord['kind'];
  title: string;
  body: string;
  contradiction: boolean;
}

/** Classify a manually-captured memory entry by a leading `marker:` convention. */
function classifyMemory(content: string): MemoryKindParse {
  const trimmed = content.trim();
  const m = trimmed.match(/^([a-z][a-z-]*)\s*:\s*([\s\S]+)$/i);
  const marker = m?.[1]?.toLowerCase();
  const rest = (m?.[2] ?? trimmed).trim();
  const titleFrom = (s: string) => excerpt(s, 80);
  switch (marker) {
    case 'decision':
      return { kind: 'decision', title: titleFrom(rest), body: rest, contradiction: false };
    case 'commitment':
    case 'promise':
      return { kind: 'commitment', title: titleFrom(rest), body: rest, contradiction: false };
    case 'meeting':
    case 'meeting-note':
      return { kind: 'meeting-note', title: titleFrom(rest), body: rest, contradiction: false };
    case 'entity':
    case 'person':
    case 'org':
      return { kind: 'entity', title: titleFrom(rest), body: rest, contradiction: false };
    case 'contradiction':
      return {
        kind: 'project-context',
        title: `Contradiction: ${titleFrom(rest)}`,
        body: rest,
        contradiction: true,
      };
    default:
      return {
        kind: 'project-context',
        title: titleFrom(trimmed),
        body: trimmed,
        contradiction: false,
      };
  }
}

export interface BrainInput {
  projectId: string;
  now: string;
  brief: ProjectBriefRow | null;
  decisions: DecisionRow[];
  questions: OpenQuestionRow[];
  risks: RiskRow[];
  milestones: MilestoneRow[];
  tasks: TaskRow[];
  memory: MemoryEntryRow[];
  timeline: AmritaEvent[];
  sources: KnowledgeSource[];
  staleDays?: number;
}

/**
 * Derive the maintained Project Brain: normalized records (with provenance and
 * `[[links]]`), gaps, a maintenance timeline, and counts. Pure and deterministic.
 */
export function buildProjectBrain(input: BrainInput): ProjectBrain {
  const { projectId, now } = input;
  const staleMs = (input.staleDays ?? DEFAULT_STALE_DAYS) * 24 * 60 * 60 * 1000;
  const nowMs = Date.parse(now);
  const records: KnowledgeRecord[] = [];
  const gaps: KnowledgeGap[] = [];

  const supersededIds = new Set(
    input.decisions.map((d) => d.supersedesId).filter((x): x is string => !!x),
  );

  // 1. Brief → project-context
  if (input.brief) {
    const b = input.brief;
    const milestoneLinks = input.milestones.map((m) => `project-context:${m.id}`);
    const bodyLines = [
      `# ${b.goal}`,
      b.audience ? `\n**Audience:** ${b.audience}` : '',
      b.successCriteria.length ? `\n**Success:** ${b.successCriteria.join('; ')}` : '',
      b.scope.length ? `\n**In scope:** ${b.scope.join('; ')}` : '',
      b.noScope.length ? `\n**Out of scope:** ${b.noScope.join('; ')}` : '',
    ].filter(Boolean);
    records.push({
      slug: 'project-context:brief',
      kind: 'project-context',
      title: `Project brief: ${excerpt(b.goal, 60)}`,
      body: bodyLines.join('\n'),
      projectId,
      owner: null,
      date: dateOf(b.updatedAt),
      confidence: 'high',
      tags: ['brief'],
      links: milestoneLinks,
      status: 'active',
      provenance: { sourceId: 'manual', ref: 'brief', capturedAt: b.updatedAt },
    });
  }

  // 2. Decisions → decision records
  for (const d of input.decisions) {
    const slug = `decision:${d.id}`;
    const resolvedQs = input.questions
      .filter((q) => q.resolvedByDecisionId === d.id)
      .map((q) => `open-question:${q.id}`);
    const links = [...(d.supersedesId ? [`decision:${d.supersedesId}`] : []), ...resolvedQs];
    const isSuperseded = supersededIds.has(d.id);
    records.push({
      slug,
      kind: 'decision',
      title: excerpt(d.text, 80),
      body: d.text,
      projectId,
      owner: null,
      date: dateOf(d.createdAt),
      confidence: 'high',
      // [cinema]-prefixed decisions were recorded by the Cinema module (applied
      // plans / format choices) — carry module provenance (ADR-0030).
      tags: [
        'decision',
        ...(d.text.startsWith('[cinema]') ? ['cinema'] : []),
        ...parseTags(d.text),
      ],
      links,
      status: isSuperseded ? 'superseded' : 'active',
      provenance: {
        sourceId: d.text.startsWith('[cinema]') ? 'module:cinema' : 'manual',
        ref: slug,
        capturedAt: d.createdAt,
      },
    });
  }

  // 3. Open questions → open-question records (+ unresolved gaps); resolved → linked
  for (const q of input.questions) {
    if (q.status === 'dropped') continue;
    const slug = `open-question:${q.id}`;
    const links = q.resolvedByDecisionId ? [`decision:${q.resolvedByDecisionId}`] : [];
    records.push({
      slug,
      kind: 'open-question',
      title: excerpt(q.text, 80),
      body: q.resolution ? `${q.text}\n\n**Resolved:** ${q.resolution}` : q.text,
      projectId,
      owner: null,
      date: dateOf(q.createdAt),
      confidence: q.status === 'resolved' ? 'high' : 'medium',
      tags: ['question', ...parseTags(q.text)],
      links,
      status: q.status === 'resolved' ? 'resolved' : 'active',
      provenance: { sourceId: 'manual', ref: slug, capturedAt: q.createdAt },
    });
    if (q.status === 'open') {
      gaps.push({
        kind: 'unresolved-question',
        severity: 'medium',
        recordSlug: slug,
        detail: `Open question with no decision: ${excerpt(q.text, 80)}`,
      });
    }
  }

  // 4. Open risks → project-context (risk) records; high + ownerless → gap
  for (const r of input.risks) {
    if (r.status !== 'open') continue;
    const slug = `project-context:${r.id}`;
    records.push({
      slug,
      kind: 'project-context',
      title: `Risk: ${excerpt(r.text, 70)}`,
      body: r.text,
      projectId,
      owner: null,
      date: dateOf(r.createdAt),
      confidence: 'medium',
      tags: ['risk', ...(r.severity ? [`sev-${r.severity}`] : []), ...parseTags(r.text)],
      links: [],
      status: 'active',
      provenance: { sourceId: 'manual', ref: slug, capturedAt: r.createdAt },
    });
    if (r.severity === 'high') {
      gaps.push({
        kind: 'missing-owner',
        severity: 'high',
        recordSlug: slug,
        detail: `High-severity risk has no owner: ${excerpt(r.text, 70)}`,
      });
    }
  }

  // 5. Milestones → project-context records (links to their tasks)
  for (const m of input.milestones) {
    const slug = `project-context:${m.id}`;
    const taskLinks = input.tasks
      .filter((t) => t.milestoneId === m.id && t.externalRef)
      .map((t) => `source-excerpt:${t.id}`);
    const status =
      m.status === 'done' ? 'resolved' : m.status === 'dropped' ? 'superseded' : 'active';
    records.push({
      slug,
      kind: 'project-context',
      title: `Milestone: ${excerpt(m.title, 70)}`,
      body: m.description ?? m.title,
      projectId,
      owner: null,
      date: m.targetDate,
      confidence: 'medium',
      tags: ['milestone'],
      links: taskLinks,
      status,
      provenance: { sourceId: 'manual', ref: slug, capturedAt: m.updatedAt },
    });
    if (m.status !== 'done' && m.status !== 'dropped' && !m.targetDate) {
      gaps.push({
        kind: 'missing-date',
        severity: 'low',
        recordSlug: slug,
        detail: `Active milestone has no target date: ${excerpt(m.title, 60)}`,
      });
    }
  }

  // 6. External tasks → source-excerpt records (honest GitHub provenance)
  for (const t of input.tasks) {
    if (!t.externalRef) continue;
    const slug = `source-excerpt:${t.id}`;
    records.push({
      slug,
      kind: 'source-excerpt',
      title: excerpt(t.title, 80),
      body: t.body ?? t.title,
      projectId,
      owner: null,
      date: dateOf(t.createdAt),
      confidence: 'medium',
      tags: ['imported', ...(t.milestoneId ? [] : [])],
      links: t.milestoneId ? [`project-context:${t.milestoneId}`] : [],
      status: t.status === 'done' ? 'resolved' : 'active',
      provenance: { sourceId: 'repo', ref: t.externalRef, capturedAt: t.createdAt },
    });
  }

  // 7. Memory entries → classified records (manual capture / source excerpts)
  for (const e of input.memory) {
    // 7a. Cinema module digests (ADR-0030): the module's synced production
    // digest becomes a project-context record with module provenance. The
    // entry is idempotent per project, so the slug is stable across re-syncs.
    if ((e.source ?? '').toLowerCase() === 'module:cinema') {
      const firstLine = e.content.split('\n')[0] ?? 'Cinema production digest';
      records.push({
        slug: `project-context:${e.id}`,
        kind: 'project-context',
        title: excerpt(firstLine, 80),
        body: e.content,
        projectId,
        owner: null,
        date: dateOf(e.createdAt),
        confidence: 'high',
        tags: ['cinema', 'digest'],
        links: [],
        status: 'active',
        provenance: {
          sourceId: 'module:cinema',
          ref: `cinema-digest:${e.id}`,
          capturedAt: e.createdAt,
        },
      });
      continue;
    }
    const c = classifyMemory(e.content);
    const slug = `${c.kind}:${e.id}`;
    const sourceId = sourceIdForMemory(e.source);
    const owner = c.kind === 'commitment' ? parseOwner(e.content) : null;
    const date = c.kind === 'commitment' ? parseDueDate(e.content) : dateOf(e.createdAt);
    records.push({
      slug,
      kind: c.kind,
      title: c.title,
      body: c.body,
      projectId,
      owner,
      date,
      confidence: 'medium',
      tags: parseTags(e.content),
      links: [],
      status: 'active',
      provenance: {
        sourceId,
        ref: e.source ?? `memory:${e.id}`,
        capturedAt: e.createdAt,
      },
    });
    if (c.kind === 'commitment' && !owner) {
      gaps.push({
        kind: 'missing-owner',
        severity: 'medium',
        recordSlug: slug,
        detail: `Commitment has no owner (use @name): ${c.title}`,
      });
    }
    if (c.kind === 'commitment' && !date) {
      gaps.push({
        kind: 'missing-date',
        severity: 'low',
        recordSlug: slug,
        detail: `Commitment has no due date (use due:YYYY-MM-DD): ${c.title}`,
      });
    }
    if (c.contradiction) {
      gaps.push({
        kind: 'contradiction',
        severity: 'high',
        recordSlug: slug,
        detail: `Flagged contradiction (surfaced, not hidden): ${c.title}`,
      });
    }
  }

  // ── linking agent: shared-tag links (bounded, dedup) ──────────────────────
  const byTag = new Map<string, string[]>();
  for (const r of records) {
    for (const tag of r.tags) {
      const arr = byTag.get(tag) ?? [];
      arr.push(r.slug);
      byTag.set(tag, arr);
    }
  }
  const bySlug = new Map(records.map((r) => [r.slug, r]));
  for (const [, slugs] of byTag) {
    if (slugs.length < 2 || slugs.length > 8) continue; // skip noise tags
    for (const slug of slugs) {
      const rec = bySlug.get(slug);
      if (!rec) continue;
      for (const other of slugs) {
        if (other !== slug && !rec.links.includes(other)) rec.links.push(other);
      }
    }
  }

  // ── maintainer agent: orphan + stale gaps, mark stale records ─────────────
  for (const r of records) {
    const orphanKinds = ['decision', 'commitment', 'meeting-note', 'entity'];
    if (orphanKinds.includes(r.kind) && r.links.length === 0) {
      gaps.push({
        kind: 'orphan',
        severity: 'low',
        recordSlug: r.slug,
        detail: `Orphan ${r.kind} — not linked to any other record: ${r.title}`,
      });
    }
    const stamp = r.provenance.capturedAt ?? (r.date ? `${r.date}T00:00:00.000Z` : null);
    if (
      r.status === 'active' &&
      stamp &&
      Number.isFinite(nowMs) &&
      nowMs - Date.parse(stamp) > staleMs
    ) {
      r.status = 'stale';
      gaps.push({
        kind: 'stale',
        severity: 'low',
        recordSlug: r.slug,
        detail: `No update in over ${input.staleDays ?? DEFAULT_STALE_DAYS} days: ${r.title}`,
      });
    }
  }

  const maintenance = deriveMaintenance(input.timeline);
  const sourcesConnected = input.sources.filter((s) => s.status === 'connected').length;
  const sourcesManual = input.sources.filter((s) => s.status === 'manual').length;
  const sourcesPlanned = input.sources.filter((s) => s.status === 'planned').length;

  return {
    projectId,
    records,
    gaps,
    sources: input.sources,
    maintenance,
    counts: {
      records: records.length,
      gaps: gaps.length,
      sourcesConnected,
      sourcesManual,
      sourcesPlanned,
    },
  };
}

const MAINTENANCE_MAP: Record<string, { agent: MaintenanceEvent['agent']; action: string }> = {
  'decision.recorded': { agent: 'ingest', action: 'extracted a decision' },
  'decision.superseded': { agent: 'maintain', action: 'superseded a decision' },
  'question.opened': { agent: 'maintain', action: 'flagged an open question' },
  'question.resolved': { agent: 'link', action: 'linked a question to its decision' },
  'risk.opened': { agent: 'maintain', action: 'flagged a risk' },
  'milestone.created': { agent: 'ingest', action: 'captured a milestone' },
  'brief.updated': { agent: 'ingest', action: 'updated project context (brief)' },
  'memory.updated': { agent: 'ingest', action: 'captured knowledge' },
  'memory.written': { agent: 'ingest', action: 'captured knowledge' },
  'task.created': { agent: 'ingest', action: 'captured a task' },
};

function deriveMaintenance(timeline: AmritaEvent[], limit = 25): MaintenanceEvent[] {
  const out: MaintenanceEvent[] = [];
  for (const ev of timeline) {
    const map = MAINTENANCE_MAP[ev.type];
    if (!map) continue;
    const payload = ev.payload as Record<string, unknown>;
    const text =
      (typeof payload.text === 'string' && payload.text) ||
      (typeof payload.title === 'string' && payload.title) ||
      (typeof payload.goal === 'string' && payload.goal) ||
      (typeof payload.content === 'string' && payload.content) ||
      '';
    out.push({
      ts: ev.ts,
      agent: map.agent,
      action: map.action,
      detail: text ? excerpt(text, 100) : ev.type,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** The durable Markdown output for one record (manual-capture / export format). */
export function renderRecordMarkdown(r: KnowledgeRecord): string {
  const meta = [
    `kind: ${r.kind}`,
    `status: ${r.status}`,
    r.owner ? `owner: ${r.owner}` : null,
    r.date ? `date: ${r.date}` : null,
    `confidence: ${r.confidence}`,
    `source: ${r.provenance.sourceId}${r.provenance.ref ? ` (${r.provenance.ref})` : ''}`,
    r.tags.length ? `tags: ${r.tags.join(', ')}` : null,
  ].filter(Boolean);
  const links = r.links.length ? `\n\n${r.links.map((l) => `[[${l}]]`).join(' ')}` : '';
  return `---\n${meta.join('\n')}\n---\n\n# ${r.title}\n\n${r.body}${links}\n`;
}
