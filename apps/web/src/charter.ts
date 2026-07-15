/**
 * The charter — pure parse/format (ADR-0044).
 *
 * Constraints and decision rights are structured, but typing them into a grid of
 * inputs is miserable. So the UI edits them as plain lines and this module owns
 * the (testable) translation both ways.
 *
 * Syntax, deliberately forgiving:
 *
 *   budget: $15K net, no overrun (hard)     → {kind:'budget', text:'…', hard:true}
 *   date: third Saturday of October (hard)  → {kind:'date',   text:'…', hard:true}
 *   one full-time organizer                 → {kind:'policy', text:'…', hard:false}
 *
 *   vendor list -> the arts council         → {area:'vendor list', approver:'…'}
 *   spend over $1K: Casey                   → {area:'spend over $1K', approver:'Casey'}
 *
 * `hard` — fixed vs negotiable — is the boundary the whole method turns on, so it
 * is explicit and defaults to FALSE. A constraint is only immovable if you say so.
 */
import type { ConstraintKind, DecisionRight, ProjectConstraint } from '@amrita/protocol';

const KINDS: ConstraintKind[] = ['budget', 'date', 'resource', 'policy'];

/** Strip a trailing `(hard)` / `(fixed)` marker. Returns the flag and the rest. */
function takeHard(text: string): { text: string; hard: boolean } {
  const m = text.match(/\s*\((hard|fixed|non-negotiable)\)\s*$/i);
  if (!m) return { text: text.trim(), hard: false };
  return { text: text.slice(0, m.index).trim(), hard: true };
}

export function parseConstraints(input: string): ProjectConstraint[] {
  const out: ProjectConstraint[] = [];
  for (const raw of input.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    let kind: ConstraintKind = 'policy';
    let rest = line;
    const colon = line.indexOf(':');
    if (colon > 0) {
      const head = line.slice(0, colon).trim().toLowerCase();
      const found = KINDS.find((k) => k === head);
      if (found) {
        kind = found;
        rest = line.slice(colon + 1);
      }
    }

    const { text, hard } = takeHard(rest);
    if (!text) continue;
    out.push({ kind, text: text.slice(0, 300), hard });
  }
  return out;
}

export function formatConstraints(constraints: readonly ProjectConstraint[]): string {
  return constraints.map((c) => `${c.kind}: ${c.text}${c.hard ? ' (hard)' : ''}`).join('\n');
}

export function parseDecisionRights(input: string): DecisionRight[] {
  const out: DecisionRight[] = [];
  for (const raw of input.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    // `->` first: an area may legitimately contain a colon ("spend over $1K: …")
    const sep = line.includes('->') ? '->' : line.includes('→') ? '→' : ':';
    const at = line.indexOf(sep);
    if (at <= 0) continue;
    const area = line.slice(0, at).trim();
    const approver = line.slice(at + sep.length).trim();
    if (!area || !approver) continue;
    out.push({ area: area.slice(0, 200), approver: approver.slice(0, 200) });
  }
  return out;
}

export function formatDecisionRights(rights: readonly DecisionRight[]): string {
  return rights.map((r) => `${r.area} -> ${r.approver}`).join('\n');
}

/** A short human label for a constraint, for the read-only view. */
export function constraintLabel(c: ProjectConstraint): string {
  return `${c.text}${c.hard ? ' · fixed' : ''}`;
}
