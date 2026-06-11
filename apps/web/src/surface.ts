/**
 * The Native Interactive Surface — Stage A (structured artifacts only).
 *
 * Pure builders that derive typed `ArtifactSpec`s from REAL project state
 * (brief, milestones, tasks). No generated code executes, no sample data is
 * invented: an empty project yields an empty surface, and the panel says so.
 * See docs/strategy/native-interactive-surface.md §2.2/§2.3 — this module is
 * the deterministic-renderer stage; sandboxed HTML previews are a later,
 * security-gated stage.
 */

import type { BrandLite, BriefLite, MilestoneLite, PreviewApprovalLite } from './api.ts';

export interface ArtifactBase {
  /** Stable render key, derived from kind + project. */
  id: string;
  projectId: string;
  /** Provenance: when the underlying typed state last changed, if known. */
  sourceUpdatedAt?: string;
}

export interface BriefSummaryArtifact extends ArtifactBase {
  kind: 'brief-summary';
  goal: string;
  audience?: string;
  successCriteria: string[];
  scope: string[];
  noScope: string[];
}

export interface MilestoneBoardItem {
  id: string;
  title: string;
  status: MilestoneLite['status'];
  targetDate?: string;
  /** Open (not done/dropped) tasks linked to this milestone. */
  openTasks: number;
}

export interface MilestoneBoardArtifact extends ArtifactBase {
  kind: 'milestone-board';
  items: MilestoneBoardItem[];
  unassignedOpenTasks: number;
}

/** A verification receipt for the most recently finished lane (mandate→report). */
export interface LaneReceiptArtifact extends ArtifactBase {
  kind: 'lane-receipt';
  laneId: string;
  laneKind: string;
  exit: string;
  goal?: string;
  summary?: string;
}

/**
 * A sandboxed HTML preview (Stage B, ADR-0020): deterministic template over
 * brief + brand + plan. Renders ONLY inside the sandbox harness, with a
 * proposed→approved lifecycle keyed by content hash. Never auto-approved.
 */
export interface HtmlPreviewArtifact extends ArtifactBase {
  kind: 'html-preview';
  title: string;
  html: string;
  contentHash: string;
  status: 'proposed' | 'approved';
}

export type ArtifactSpec =
  | BriefSummaryArtifact
  | MilestoneBoardArtifact
  | LaneReceiptArtifact
  | HtmlPreviewArtifact;

export interface SurfaceInputs {
  projectId: string;
  brief: BriefLite | null;
  brand?: BrandLite | null;
  milestones: MilestoneLite[];
  tasks: { id: string; status?: string; milestoneId?: string | null }[];
  /** Lane views from the live stream (most-recent first, as lanesList returns). */
  lanes?: {
    id: string;
    kind: string;
    status: string;
    goal?: string;
    exit?: string;
    summary?: string;
  }[];
  /** Durable preview approvals for this project (ADR-0020). */
  previewApprovals?: PreviewApprovalLite[];
}

/** Deterministic FNV-1a hash — change detection only; the sandbox is the security boundary. */
export function contentHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** HTML-escape every interpolated project string (defense in depth inside the sandbox). */
export function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** The first #hex found in the brand's palette notes, if any (used as accent). */
function paletteAccent(brand: BrandLite | null | undefined): string | undefined {
  for (const note of brand?.palette ?? []) {
    const m = note.match(/#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/);
    if (m) return m[0];
  }
  return undefined;
}

/**
 * The first product-real preview: a one-page project cover derived from brief
 * + brand + plan. Deterministic; brand-less projects get neutral defaults that
 * SAY they are neutral — never an invented identity.
 */
function renderPreviewHtml(inputs: SurfaceInputs): string {
  const brief = inputs.brief;
  const brand = inputs.brand ?? null;
  const accent = paletteAccent(brand) ?? '#3b3b3b';
  const title = escapeHtml(brand?.name ?? brief?.goal ?? 'Untitled project');
  const tagline = brand?.tone
    ? escapeHtml(brand.tone)
    : brief?.audience
      ? `for ${escapeHtml(brief.audience)}`
      : '';
  const criteria = (brief?.successCriteria ?? []).map((s) => `<li>${escapeHtml(s)}</li>`).join('');
  const active = inputs.milestones.find((m) => m.status === 'active');
  const nextMilestone = active ?? inputs.milestones.find((m) => m.status === 'planned');
  const openTasks = inputs.tasks.filter(
    (t) => t.status !== 'done' && t.status !== 'dropped',
  ).length;
  const brandNote = brand
    ? ''
    : '<p class="meta">neutral preview — no brand memory set for this project yet</p>';

  return [
    '<style>body{margin:0;font-family:system-ui,sans-serif;background:#101013;color:#f4f2ee;padding:48px 40px}',
    `.accent{color:${accent}}.rule{height:3px;width:56px;background:${accent};border:0;margin:18px 0}`,
    'h1{margin:0;font-size:34px;letter-spacing:-.02em}p{line-height:1.5}',
    '.tag{color:#b8b2a8;font-size:15px;margin-top:6px}ul{padding-left:20px;line-height:1.7}',
    '.meta{color:#7d776e;font-size:12px;margin-top:28px}</style>',
    `<h1>${title}</h1>`,
    tagline ? `<p class="tag">${tagline}</p>` : '',
    `<hr class="rule">`,
    brief && brand?.name ? `<p>${escapeHtml(brief.goal)}</p>` : '',
    criteria
      ? `<p class="accent" style="margin-bottom:4px">done means</p><ul>${criteria}</ul>`
      : '',
    nextMilestone
      ? `<p><span class="accent">next:</span> ${escapeHtml(nextMilestone.title)}${
          nextMilestone.targetDate ? ` · ${escapeHtml(nextMilestone.targetDate)}` : ''
        }${openTasks > 0 ? ` · ${openTasks} open task${openTasks > 1 ? 's' : ''}` : ''}</p>`
      : '',
    brandNote,
    `<p class="meta">generated by Amrita from this project's typed state</p>`,
  ]
    .filter(Boolean)
    .join('');
}

function isOpenTask(t: { status?: string }): boolean {
  return t.status !== 'done' && t.status !== 'dropped';
}

/** Derive the Stage-A surface. Pure and deterministic; [] when there is nothing real to show. */
export function buildSurfaceArtifacts(inputs: SurfaceInputs): ArtifactSpec[] {
  const artifacts: ArtifactSpec[] = [];

  if (inputs.brief) {
    const b = inputs.brief;
    artifacts.push({
      kind: 'brief-summary',
      id: `brief-summary:${inputs.projectId}`,
      projectId: inputs.projectId,
      sourceUpdatedAt: b.updatedAt,
      goal: b.goal,
      ...(b.audience ? { audience: b.audience } : {}),
      successCriteria: b.successCriteria,
      scope: b.scope,
      noScope: b.noScope,
    });
  }

  if (inputs.milestones.length > 0) {
    const openTasks = inputs.tasks.filter(isOpenTask);
    artifacts.push({
      kind: 'milestone-board',
      id: `milestone-board:${inputs.projectId}`,
      projectId: inputs.projectId,
      items: inputs.milestones.map((m) => ({
        id: m.id,
        title: m.title,
        status: m.status,
        ...(m.targetDate ? { targetDate: m.targetDate } : {}),
        openTasks: openTasks.filter((t) => t.milestoneId === m.id).length,
      })),
      unassignedOpenTasks: openTasks.filter((t) => !t.milestoneId).length,
    });
  }

  // Stage-B preview: only when there is REAL identity or intent to derive from.
  if (inputs.brief || inputs.brand) {
    const html = renderPreviewHtml(inputs);
    const hash = contentHash(html);
    const previewId = `html-preview:${inputs.projectId}`;
    const approved = (inputs.previewApprovals ?? []).some(
      (a) => a.previewId === previewId && a.contentHash === hash,
    );
    artifacts.push({
      kind: 'html-preview',
      id: previewId,
      projectId: inputs.projectId,
      title: inputs.brand?.name ?? 'Project cover',
      html,
      contentHash: hash,
      // approved ONLY when the stored approval matches this exact content;
      // any state drift demotes honestly back to proposed.
      status: approved ? 'approved' : 'proposed',
    });
  }

  // The most recent FINISHED lane becomes a receipt — proof of delegated work.
  const finished = (inputs.lanes ?? []).find((l) => l.exit);
  if (finished) {
    artifacts.push({
      kind: 'lane-receipt',
      id: `lane-receipt:${finished.id}`,
      projectId: inputs.projectId,
      laneId: finished.id,
      laneKind: finished.kind,
      exit: finished.exit ?? 'unknown',
      ...(finished.goal ? { goal: finished.goal } : {}),
      ...(finished.summary ? { summary: finished.summary } : {}),
    });
  }

  return artifacts;
}
