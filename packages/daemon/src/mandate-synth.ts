/**
 * Turn a chat request + project truth into a `LaneMandate` (ADR-0048).
 *
 * This generalizes the goal-assembly that lived inside `delegateTask` (which only
 * concatenated a task title/body with the brief) so it can key off a raw chat
 * message. The output is parsed by `laneMandateSchema` — the schema IS the boundary
 * (the constitution), so a malformed mandate throws here rather than reaching a lane.
 *
 * Pure: every input is injected. Scope `paths` is left UNSET so `startLane`
 * synthesizes the per-lane jailed workspace (ADR-0039); two jailed lanes therefore
 * cannot conflict by construction, so no active-scope input is needed at v1.
 *
 * `approvals` is fixed at `'forward'` so real execution stays behind the human gate
 * (ADR-0021); whether a spawn is auto or gated is decided by the Approval
 * Constitution resolver at the kernel, not by this pure builder.
 */
import { type LaneBudget, type LaneMandate, laneMandateSchema } from '@amrita/protocol';
import type { DecisionRow, MemoryEntryRow, ProjectBriefRow } from '@amrita/store';

export interface MandateSynthInput {
  laneId: string;
  /** The operator's message — the thing to be built/researched. */
  requestText: string;
  brief: ProjectBriefRow | null;
  /** Relevant-first is fine; we take a bounded head. */
  memory: MemoryEntryRow[];
  /** The event log is oldest-first; we take a bounded tail (the recent ones). */
  decisions: DecisionRow[];
  budget: LaneBudget;
}

const MAX_GOAL = 4000; // laneMandateSchema goal cap
const CAP = { memory: 6, decisions: 6 } as const;

export function buildMandateFromChat(input: MandateSynthInput): LaneMandate {
  const request = input.requestText.trim();
  const charter = [
    input.brief?.goal ? `\n\nProject goal: ${input.brief.goal}` : '',
    input.brief?.finishLine ? `\nDone means: ${input.brief.finishLine}` : '',
  ].join('');
  // The request leads; the charter grounds it. Bounded to the schema's goal cap.
  const goal = `${request}${charter}`.slice(0, MAX_GOAL) || request.slice(0, MAX_GOAL) || 'Assist';

  return laneMandateSchema.parse({
    laneId: input.laneId,
    goal,
    contextPack: {
      memory: input.memory.slice(0, CAP.memory).map((m) => m.content),
      files: [],
      decisions: input.decisions.slice(-CAP.decisions).map((d) => d.text),
    },
    // paths unset → startLane jails the lane to <workspacesRoot>/<laneId>.
    scope: { network: 'none' },
    budget: input.budget,
    approvals: 'forward',
    deliverables: [],
  });
}
