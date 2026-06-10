import {
  type LaneMandate,
  type MergeReport,
  type Usage,
  mergeReportSchema,
} from '@amrita/protocol';

/**
 * The lane runner boundary. A *lane* is a delegated unit of real work (e.g. a
 * Claude Code run) launched beside a conversation. A `LaneRunner` turns a
 * `LaneMandate` (what to do, within what scope/budget) into a `MergeReport`
 * (what it did, with what cost and exit). These two types are the hard contract
 * (protocol `lane.ts`); a runner never widens them.
 *
 * Every runner here is **side-effect-injectable**: the real Claude Code runner
 * takes a `ProcessRunner`, so tests (and CI) never spawn a child process. See
 * ADR-0014.
 */

/** A lane's terminal disposition (mirrors the protocol merge-report `exit`). */
export type LaneExit = 'done' | 'partial' | 'aborted' | 'budget';

export interface LaneRunContext {
  /** Progress sink — the daemon forwards these to `lane.progress` events. */
  onProgress?: (note: string, pct?: number) => void;
  /** Cooperative cancellation. */
  signal?: AbortSignal;
}

export interface LaneRunner {
  readonly kind: string;
  run(mandate: LaneMandate, ctx?: LaneRunContext): Promise<MergeReport>;
}

// ── injectable process boundary ──────────────────────────────────────────────

export interface ProcessSpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  /** The FULLY SCRUBBED child environment (see env.ts). Never the parent env. */
  env: Record<string, string>;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs a child process. Injected so the runner is testable without real exec. */
export interface ProcessRunner {
  run(opts: ProcessSpawnOptions): Promise<ProcessResult>;
}

/** Thrown when a real (unsafe) execution is requested but not explicitly enabled. */
export class LaneSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LaneSafetyError';
  }
}

// ── shared report helpers ────────────────────────────────────────────────────

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0 };
}

export interface BuildReportExtras {
  usage?: Usage;
  artifacts?: MergeReport['artifacts'];
  decisions?: string[];
  tasks?: string[];
  followUps?: string[];
}

/** Build a schema-valid `MergeReport` for a mandate (summary is clamped to 2000). */
export function buildReport(
  mandate: LaneMandate,
  exit: LaneExit,
  summary: string,
  extras: BuildReportExtras = {},
): MergeReport {
  return mergeReportSchema.parse({
    laneId: mandate.laneId,
    summary: summary.slice(0, 2000),
    exit,
    usage: extras.usage ?? emptyUsage(),
    ...(extras.artifacts ? { artifacts: extras.artifacts } : {}),
    ...(extras.decisions ? { decisions: extras.decisions } : {}),
    ...(extras.tasks ? { tasks: extras.tasks } : {}),
    ...(extras.followUps ? { followUps: extras.followUps } : {}),
  });
}
