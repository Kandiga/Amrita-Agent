/**
 * Pure presentation helpers for the Organizational Brain Harness view (ADR-0027).
 * Kept DOM-free so the labelling/grouping/honesty logic is unit-testable. No
 * secret value ever flows through here — provenance is source ids/refs only.
 */
import type { KnowledgeGapLite, KnowledgeRecordLite, KnowledgeSourceLite } from './api.ts';

type RecordKind = KnowledgeRecordLite['kind'];
type SourceStatus = KnowledgeSourceLite['status'];

/** Render order + human titles for record kinds. */
export const RECORD_KIND_ORDER: readonly RecordKind[] = [
  'decision',
  'commitment',
  'open-question',
  'meeting-note',
  'project-context',
  'entity',
  'source-excerpt',
];

export const RECORD_KIND_LABEL: Record<RecordKind, string> = {
  decision: 'Decisions',
  commitment: 'Commitments',
  'open-question': 'Open questions',
  'meeting-note': 'Meeting notes',
  'project-context': 'Project context',
  entity: 'Entities',
  'source-excerpt': 'Source excerpts',
};

export const SOURCE_STATUS_LABEL: Record<SourceStatus, string> = {
  connected: 'connected',
  manual: 'manual',
  planned: 'planned',
};

/**
 * Badge class for a source status. Only `connected` is "ok" (green) — and that
 * is reserved for real ingestion. `manual` is a warn (you do the work), `planned`
 * is off. No fake green for an unbuilt connector.
 */
export function sourceBadgeClass(status: SourceStatus): string {
  if (status === 'connected') return 'runtime-ok';
  if (status === 'manual') return 'runtime-warn';
  return 'runtime-off';
}

export function gapBadgeClass(severity: KnowledgeGapLite['severity']): string {
  if (severity === 'high') return 'runtime-off';
  if (severity === 'medium') return 'runtime-warn';
  return 'doc-badge';
}

export interface RecordGroupView {
  kind: RecordKind;
  title: string;
  records: KnowledgeRecordLite[];
}

/** Group records by kind in render order, dropping empty groups. */
export function groupRecords(records: KnowledgeRecordLite[]): RecordGroupView[] {
  return RECORD_KIND_ORDER.map((kind) => ({
    kind,
    title: RECORD_KIND_LABEL[kind],
    records: records.filter((r) => r.kind === kind),
  })).filter((g) => g.records.length > 0);
}

/** One-line provenance string: source id + optional ref (never a secret). */
export function provenanceLabel(r: KnowledgeRecordLite): string {
  const p = r.provenance;
  return p.ref && p.ref !== r.slug ? `${p.sourceId} · ${p.ref}` : p.sourceId;
}

/** Resolve a link slug to a human title from the record set (falls back to slug). */
export function linkTitle(slug: string, records: KnowledgeRecordLite[]): string {
  return records.find((r) => r.slug === slug)?.title ?? slug;
}
