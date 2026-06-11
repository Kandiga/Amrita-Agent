import type { LaneMandate, MergeReport } from '@amrita/protocol';
import { type LaneRunContext, type LaneRunner, buildReport } from './runner.ts';

/**
 * The research-lane seam (ADR-0023). A research lane resolves its goal through
 * an injected search provider — no process spawn, no workspace mutation. No
 * provider ships in this slice: without one the lane aborts with a needs-setup
 * summary instead of pretending to search or inventing sources.
 */

export interface ResearchFinding {
  title: string;
  url: string;
  snippet?: string;
}

export interface ResearchSearchProvider {
  /** A stable id for provenance lines (e.g. `fake`, later `brave`). */
  readonly id: string;
  search(query: string, opts: { limit: number; signal?: AbortSignal }): Promise<ResearchFinding[]>;
}

const DEFAULT_RESULT_LIMIT = 5;

export class ResearchLaneRunner implements LaneRunner {
  readonly kind = 'research';
  private readonly provider: ResearchSearchProvider | undefined;

  constructor(opts: { provider?: ResearchSearchProvider } = {}) {
    this.provider = opts.provider;
  }

  async run(mandate: LaneMandate, ctx?: LaneRunContext): Promise<MergeReport> {
    if (!this.provider) {
      return buildReport(
        mandate,
        'aborted',
        'research lanes need setup — no search provider is configured on this daemon (the ResearchSearchProvider seam is unwired; see ADR-0023)',
      );
    }

    ctx?.onProgress?.(`searching via ${this.provider.id}`, 10);
    let findings: ResearchFinding[];
    try {
      findings = await this.provider.search(mandate.goal, {
        limit: DEFAULT_RESULT_LIMIT,
        ...(ctx?.signal ? { signal: ctx.signal } : {}),
      });
    } catch (e) {
      if (ctx?.signal?.aborted) return buildReport(mandate, 'cancelled', 'cancelled by operator');
      // value-free: provider errors may wrap HTTP layers; never echo bodies/headers
      const reason = e instanceof Error ? e.name : 'unknown error';
      return buildReport(mandate, 'aborted', `search provider failed (${reason})`);
    }
    if (ctx?.signal?.aborted) return buildReport(mandate, 'cancelled', 'cancelled by operator');

    if (findings.length === 0) {
      // an honest real outcome, not a failure
      return buildReport(mandate, 'partial', `no sources found via ${this.provider.id}`);
    }

    ctx?.onProgress?.(`found ${findings.length} source(s)`, 90);
    return buildReport(
      mandate,
      'done',
      `found ${findings.length} source(s) via ${this.provider.id} for: ${mandate.goal}`,
      { followUps: findings.map((f) => `${f.title} — ${f.url}`) },
    );
  }
}
