import { useCallback, useEffect, useState } from 'react';
import type { HarnessTopologyLite, KnowledgeRecordLite, ProjectBrainLite } from '../api.ts';
import { client } from '../client.ts';
import {
  SOURCE_STATUS_LABEL,
  gapBadgeClass,
  groupRecords,
  linkTitle,
  provenanceLabel,
  sourceBadgeClass,
} from '../harness-view.ts';

const KINDS: KnowledgeRecordLite['kind'][] = [
  'decision',
  'commitment',
  'meeting-note',
  'project-context',
  'open-question',
  'entity',
];

interface BrainPanelProps {
  projectId?: string | undefined;
  writeCtx: { projectId: string; conversationId: string } | null;
  onError: (e: unknown) => void;
}

/**
 * The Organizational Brain Harness view (ADR-0027). Renders the maintained
 * brain — ingestion lanes (honest status), normalized records with provenance
 * and links, gaps, and the maintenance timeline — plus a manual-capture box.
 * No secret value ever reaches this component: provenance is source ids only.
 */
export function BrainPanel({ projectId, writeCtx, onError }: BrainPanelProps) {
  const [brain, setBrain] = useState<ProjectBrainLite | null>(null);
  const [topology, setTopology] = useState<HarnessTopologyLite | null>(null);
  const [draft, setDraft] = useState({
    kind: 'decision' as KnowledgeRecordLite['kind'],
    title: '',
    owner: '',
    date: '',
    tags: '',
    body: '',
  });
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    try {
      setBrain(await client.harnessBrain(projectId));
    } catch (e) {
      onError(e);
    }
  }, [projectId, onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    client.harnessTopology().then(setTopology).catch(onError);
  }, [onError]);

  async function capture(): Promise<void> {
    if (!writeCtx || !draft.title.trim() || busy) return;
    setBusy(true);
    try {
      await client.harnessCapture({
        ...writeCtx,
        kind: draft.kind,
        title: draft.title.trim(),
        ...(draft.owner.trim() ? { owner: draft.owner.trim() } : {}),
        ...(draft.date.trim() ? { date: draft.date.trim() } : {}),
        ...(draft.body.trim() ? { body: draft.body.trim() } : {}),
        ...(draft.tags.trim()
          ? {
              tags: draft.tags
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean),
            }
          : {}),
      });
      setDraft((d) => ({ ...d, title: '', owner: '', date: '', tags: '', body: '' }));
      await refresh();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  if (!projectId) {
    return (
      <section className="card">
        <h2>Project brain</h2>
        <p className="empty-note">Select a project to see its maintained knowledge brain.</p>
      </section>
    );
  }

  const groups = brain ? groupRecords(brain.records) : [];

  return (
    <>
      <section className="card">
        <h2>Organizational brain — harness</h2>
        <p className="hub-note">
          An <strong>engineered knowledge harness</strong>, not RAG and not a graph picture. Agents
          ingest, normalize, link and maintain organizational knowledge over time — with provenance
          and honest gaps. Retrieval is a tool; the maintained brain below is the product. Markdown
          records with <code>[[links]]</code> are the durable output; the graph is optional.
        </p>
        {brain ? (
          <p className="brain-counts">
            {brain.counts.records} records · {brain.counts.gaps} gaps · sources:{' '}
            {brain.counts.sourcesConnected} connected · {brain.counts.sourcesManual} manual ·{' '}
            {brain.counts.sourcesPlanned} planned
          </p>
        ) : (
          <p className="empty-note">Loading the brain…</p>
        )}
      </section>

      <section className="card">
        <h2>Ingestion lanes</h2>
        <p className="hub-note">
          Where knowledge comes from. “connected” means real ingestion today — otherwise it is
          honestly “manual” or “planned”, with the exact next step.
        </p>
        {(brain?.sources ?? []).map((s) => (
          <div key={s.id} className="hub-runtime">
            <div className="hub-role-head">
              <strong>{s.title}</strong>
              <span className={`doc-badge ${sourceBadgeClass(s.status)}`}>
                {SOURCE_STATUS_LABEL[s.status]}
              </span>
            </div>
            <small>extracts: {s.extracts.join(', ')}</small>
            <p className="hub-detail">{s.detail}</p>
            {s.nextStep ? <code className="hub-cmd">{s.nextStep}</code> : null}
          </div>
        ))}
      </section>

      <section className="card">
        <h2>Capture into the brain</h2>
        <p className="hub-note">
          The manual capture agent: normalized into a record with provenance. Never put secrets
          here.
        </p>
        <div className="brain-capture">
          <div className="hub-role-controls">
            <select
              value={draft.kind}
              onChange={(e) =>
                setDraft((d) => ({ ...d, kind: e.target.value as KnowledgeRecordLite['kind'] }))
              }
              aria-label="Record kind"
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <input
              value={draft.title}
              onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
              placeholder="What should Amrita remember?"
              aria-label="Record title"
            />
          </div>
          <div className="hub-role-controls">
            <input
              value={draft.owner}
              onChange={(e) => setDraft((d) => ({ ...d, owner: e.target.value }))}
              placeholder="owner (optional)"
              aria-label="Owner"
            />
            <input
              value={draft.date}
              onChange={(e) => setDraft((d) => ({ ...d, date: e.target.value }))}
              placeholder="date YYYY-MM-DD (optional)"
              aria-label="Date"
            />
            <input
              value={draft.tags}
              onChange={(e) => setDraft((d) => ({ ...d, tags: e.target.value }))}
              placeholder="tags, comma-separated"
              aria-label="Tags"
            />
          </div>
          <textarea
            value={draft.body}
            onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
            placeholder="details (optional)"
            aria-label="Body"
          />
          <button
            type="button"
            disabled={busy || !writeCtx || !draft.title.trim()}
            onClick={() => void capture()}
          >
            Capture
          </button>
        </div>
      </section>

      <section className="card">
        <h2>Knowledge records</h2>
        {groups.length === 0 ? (
          <p className="empty-note">
            No records yet — capture knowledge above, or add a brief, decisions, questions and
            milestones. The brain is derived from real project state, never sample data.
          </p>
        ) : (
          groups.map((g) => (
            <div key={g.kind} className="brain-group">
              <h3 className="hub-catalog-title">{g.title}</h3>
              {g.records.map((r) => (
                <div key={r.slug} className="brain-record">
                  <div className="hub-role-head">
                    <strong dir="auto">{r.title}</strong>
                    <span className={`doc-badge brain-status-${r.status}`}>{r.status}</span>
                  </div>
                  <small>
                    source: {provenanceLabel(r)}
                    {r.owner ? ` · owner ${r.owner}` : ''}
                    {r.date ? ` · ${r.date}` : ''} · {r.confidence} confidence
                  </small>
                  {r.tags.length ? (
                    <div className="brain-tags">
                      {r.tags.map((t) => (
                        <span key={t} className="brain-tag">
                          #{t}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {r.links.length ? (
                    <p className="brain-links">
                      links:{' '}
                      {r.links.map((l, i) => (
                        <span key={l}>
                          {i > 0 ? ', ' : ''}
                          <span className="brain-link">{linkTitle(l, brain?.records ?? [])}</span>
                        </span>
                      ))}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          ))
        )}
      </section>

      {brain && brain.gaps.length > 0 ? (
        <section className="card">
          <h2>Knowledge gaps</h2>
          <p className="hub-note">
            Surfaced, not hidden: missing owners/dates/sources, orphans, unresolved questions, stale
            records, and contradictions.
          </p>
          {brain.gaps.map((gap, i) => (
            <div key={`${gap.kind}-${gap.recordSlug ?? i}`} className="brain-gap">
              <span className={`doc-badge ${gapBadgeClass(gap.severity)}`}>{gap.kind}</span>
              <span dir="auto"> {gap.detail}</span>
            </div>
          ))}
        </section>
      ) : null}

      {brain && brain.maintenance.length > 0 ? (
        <section className="card">
          <h2>Maintenance timeline</h2>
          <p className="hub-note">
            What the harness agents extracted, linked, or flagged — and why.
          </p>
          {brain.maintenance.map((m, i) => (
            <div key={`${m.ts}-${i}`} className="brain-maint">
              <span className="brain-maint-agent">{m.agent}</span>
              <span> {m.action}: </span>
              <span dir="auto" className="hub-detail">
                {m.detail}
              </span>
            </div>
          ))}
        </section>
      ) : null}

      {topology ? (
        <section className="card">
          <h2>Harness topology</h2>
          <p className="hub-note">
            The agent topology as code (v{topology.version}). Honest: “active” runs today; “planned”
            is designed, not built.
          </p>
          {topology.agents.map((a) => (
            <div key={a.id} className="hub-runtime">
              <div className="hub-role-head">
                <strong>
                  {a.title} <span className="brain-role">{a.role}</span>
                </strong>
                <span
                  className={`doc-badge ${a.status === 'active' ? 'runtime-ok' : 'runtime-off'}`}
                >
                  {a.status}
                </span>
              </div>
              <p className="hub-detail">trigger: {a.trigger}</p>
            </div>
          ))}
        </section>
      ) : null}
    </>
  );
}
