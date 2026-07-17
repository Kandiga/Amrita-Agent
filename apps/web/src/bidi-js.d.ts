/**
 * Ambient types for `bidi-js` (v1.x), which ships no declarations of its own.
 * Typed to the exact surface `terminal-bidi.ts` uses — no `any` (CLAUDE.md).
 * If the runtime API grows, widen this contract deliberately, not with `any`.
 */
declare module 'bidi-js' {
  /** Resolved Unicode Bidi levels for a string (output of getEmbeddingLevels). */
  export interface EmbeddingLevels {
    readonly levels: Uint8Array;
    readonly paragraphs: ReadonlyArray<{ start: number; end: number; level: number }>;
  }

  /** The bidi instance returned by the factory (subset in use). */
  export interface Bidi {
    getEmbeddingLevels(text: string, baseDirection?: 'ltr' | 'rtl' | 'auto'): EmbeddingLevels;
    /** Contiguous [start, end] index ranges to reverse for logical→visual order. */
    getReorderSegments(
      text: string,
      embeddingLevels: EmbeddingLevels,
      start?: number,
      end?: number,
    ): Array<[number, number]>;
  }

  /** Default export: builds a bidi instance. */
  export default function bidiFactory(): Bidi;
}
