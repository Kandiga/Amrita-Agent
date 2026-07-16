import type { AcceptanceCriterionLite } from './api.ts';

/**
 * ADR-0055 — pure helpers for the task evidence UI (unit-testable; the .tsx
 * stays declarative). Raw-JSON columns in, typed view-state out.
 */

export interface EvidenceView {
  criteria: AcceptanceCriterionLite[];
  machineCount: number;
  /** null = never verified; otherwise the latest run's outcome. */
  verified: { passed: boolean; at: string; okCount: number; total: number } | null;
}

export function parseCriteria(
  acceptanceJson: string | null | undefined,
): AcceptanceCriterionLite[] {
  if (!acceptanceJson) return [];
  try {
    const raw = JSON.parse(acceptanceJson) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (c): c is AcceptanceCriterionLite =>
        typeof c === 'object' &&
        c !== null &&
        'kind' in c &&
        (c.kind === 'file' ||
          c.kind === 'command' ||
          c.kind === 'manual' ||
          c.kind === 'github-pr'),
    );
  } catch {
    return [];
  }
}

export function evidenceView(
  acceptanceJson: string | null | undefined,
  verificationJson: string | null | undefined,
): EvidenceView {
  const criteria = parseCriteria(acceptanceJson);
  const machineCount = criteria.filter((c) => c.kind !== 'manual').length;
  let verified: EvidenceView['verified'] = null;
  if (verificationJson) {
    try {
      const v = JSON.parse(verificationJson) as {
        passed?: boolean;
        at?: string;
        results?: { ok?: boolean }[];
      };
      if (typeof v.passed === 'boolean' && typeof v.at === 'string') {
        const results = Array.isArray(v.results) ? v.results : [];
        verified = {
          passed: v.passed,
          at: v.at,
          okCount: results.filter((r) => r.ok === true).length,
          total: results.length,
        };
      }
    } catch {
      verified = null;
    }
  }
  return { criteria, machineCount, verified };
}

/** One-line human label for a criterion chip. */
export function criterionLabel(c: AcceptanceCriterionLite): string {
  if (c.kind === 'file') return `file: ${c.path}`;
  if (c.kind === 'command') return `run: ${c.run}`;
  if (c.kind === 'github-pr') return `pr: ${c.repo}#${c.number}`;
  return `manual: ${c.text}`;
}
