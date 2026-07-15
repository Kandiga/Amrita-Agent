/**
 * The free-canvas layout engine (Live Canvas, Phase 1) — pure so it is unit-
 * testable under the node vitest env (`.tsx` is not). It owns WHERE each artifact
 * card sits, how big it is, its stacking order, and whether it is minimized. This
 * is VIEW state, not domain truth: it never becomes an event; it lives in the
 * client and persists to localStorage per conversation.
 */

export interface CardLayout {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Stacking order — higher is on top. */
  z: number;
  minimized: boolean;
}

export type CanvasLayout = Record<string, CardLayout>;

export const CARD_MIN_W = 240;
export const CARD_MIN_H = 160;
const DEFAULT_W = 460;
const DEFAULT_H = 340;
const CASCADE = 30;
const MARGIN = 16;

/** The next free z (one above the current top card). */
export function topZ(layout: CanvasLayout): number {
  let max = 0;
  for (const c of Object.values(layout)) if (c.z > max) max = c.z;
  return max + 1;
}

/** A cascaded default position for the Nth card, so new cards do not stack exactly. */
function cascade(index: number): { x: number; y: number } {
  return { x: MARGIN + (index % 6) * CASCADE, y: MARGIN + (index % 6) * CASCADE };
}

/**
 * Add a layout entry for every id that lacks one (cascaded, each on top), and drop
 * entries whose artifact is gone. Stable for ids already placed — moving/resizing
 * a card is never undone by a new artifact arriving.
 */
export function reconcile(layout: CanvasLayout, ids: readonly string[]): CanvasLayout {
  const next: CanvasLayout = {};
  const known = new Set(ids);
  for (const id of ids) {
    if (layout[id]) {
      next[id] = layout[id];
    }
  }
  let placedThisPass = 0;
  let z = topZ(next);
  for (const id of ids) {
    if (next[id]) continue;
    const at = cascade(Object.keys(next).length + placedThisPass);
    next[id] = { id, x: at.x, y: at.y, w: DEFAULT_W, h: DEFAULT_H, z: z++, minimized: false };
    placedThisPass += 1;
  }
  // Drop nothing extra — `next` was built only from `ids`, so removed artifacts are
  // already absent. `known` guards a caller that hands us a stale layout key.
  for (const key of Object.keys(next)) if (!known.has(key)) delete next[key];
  return next;
}

/** Raise a card to the top of the stack (no-op if already there or unknown). */
export function raise(layout: CanvasLayout, id: string): CanvasLayout {
  const card = layout[id];
  if (!card) return layout;
  const z = topZ(layout);
  if (card.z === z - 1 && z > 1) return layout; // already on top
  return { ...layout, [id]: { ...card, z } };
}

/** Move a card by a pixel delta, clamped so it never leaves the top-left origin. */
export function moveCard(layout: CanvasLayout, id: string, dx: number, dy: number): CanvasLayout {
  const card = layout[id];
  if (!card) return layout;
  return {
    ...layout,
    [id]: { ...card, x: Math.max(0, card.x + dx), y: Math.max(0, card.y + dy) },
  };
}

/** Resize a card by a delta, clamped to the minimum. */
export function resizeCard(layout: CanvasLayout, id: string, dw: number, dh: number): CanvasLayout {
  const card = layout[id];
  if (!card) return layout;
  return {
    ...layout,
    [id]: {
      ...card,
      w: Math.max(CARD_MIN_W, card.w + dw),
      h: Math.max(CARD_MIN_H, card.h + dh),
    },
  };
}

/** Set an absolute position (used when a drag ends with an absolute pointer point). */
export function setPosition(layout: CanvasLayout, id: string, x: number, y: number): CanvasLayout {
  const card = layout[id];
  if (!card) return layout;
  return { ...layout, [id]: { ...card, x: Math.max(0, x), y: Math.max(0, y) } };
}

/** Set an absolute size, clamped to the minimum (commit point of a resize gesture). */
export function setSize(layout: CanvasLayout, id: string, w: number, h: number): CanvasLayout {
  const card = layout[id];
  if (!card) return layout;
  return {
    ...layout,
    [id]: { ...card, w: Math.max(CARD_MIN_W, w), h: Math.max(CARD_MIN_H, h) },
  };
}

export function toggleMinimized(layout: CanvasLayout, id: string): CanvasLayout {
  const card = layout[id];
  if (!card) return layout;
  return { ...layout, [id]: { ...card, minimized: !card.minimized } };
}

// ── persistence (view state only, never the event store) ─────────────────────

const KEY_PREFIX = 'amrita.canvas.';

export function loadLayout(conversationId: string): CanvasLayout {
  if (typeof localStorage === 'undefined' || !conversationId) return {};
  try {
    const raw = localStorage.getItem(KEY_PREFIX + conversationId);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    // Keep only well-formed entries; a corrupt value must never crash the canvas.
    const out: CanvasLayout = {};
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      const c = v as Partial<CardLayout>;
      if (
        typeof c?.x === 'number' &&
        typeof c?.y === 'number' &&
        typeof c?.w === 'number' &&
        typeof c?.h === 'number'
      ) {
        out[id] = {
          id,
          x: c.x,
          y: c.y,
          w: Math.max(CARD_MIN_W, c.w),
          h: Math.max(CARD_MIN_H, c.h),
          z: typeof c.z === 'number' ? c.z : 1,
          minimized: c.minimized === true,
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function saveLayout(conversationId: string, layout: CanvasLayout): void {
  if (typeof localStorage === 'undefined' || !conversationId) return;
  try {
    localStorage.setItem(KEY_PREFIX + conversationId, JSON.stringify(layout));
  } catch {
    /* quota / disabled storage: layout is ephemeral, never fatal */
  }
}
