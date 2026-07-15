/**
 * Which execution agent runs a delegated job (ADR-0048).
 *
 * The owner wants to CHOOSE — Claude Code for one thing, Codex for another, or one
 * verifying the other. So selection is `override > policy`: an explicit operator pick
 * always wins; otherwise a deterministic default policy fills the gap. Honest by
 * construction: if the chosen (or every) runtime is not ready, this returns `human`
 * with the exact `nextCommand` to fix it — never a fake "running" state.
 *
 * Pure: every input is injected (runtime statuses come from `getCodingRuntimes`). No
 * clock, no store, no probes — so it is exhaustively unit-testable, like `routeFor`.
 */
import type { CodingRuntimeStatusWire } from '@amrita/protocol';
import type { IntentKind } from './execution-route.ts';

/** An agent Amrita can hand a job to. A runtime `id` maps 1:1 to a lane `kind`. */
export type AgentKind = 'claude-code' | 'codex' | 'human';

export interface AgentSelectInput {
  intent: IntentKind;
  /** Live runtime readiness, from `getCodingRuntimes()`. */
  runtimes: CodingRuntimeStatusWire[];
  /** Is this daemon allowed to really execute at all? */
  realExecution: boolean;
  /** Default preference order (settings `orchestration.agentPriority`). */
  priority?: string[];
  /** An explicit operator pick — always wins when ready. */
  override?: string;
}

export interface AgentChoice {
  kind: AgentKind;
  via: 'override' | 'policy' | 'only-ready' | 'none-ready';
  detail: string;
  /** For a `human` verdict: exactly what is missing and how to fix it. */
  missing?: { what: string; why: string; fix: string; nextCommand?: string };
  /** The other ready agents — a future parallel/compare mode grafts onto this. */
  alternatives: AgentKind[];
}

/** Which agents can plausibly serve each delegatable intent (best-fit first). */
const CANDIDATES: Partial<Record<IntentKind, AgentKind[]>> = {
  // Claude Code leads for building/refactoring; Codex leads for research/QA. Owner
  // decision (2026-07-15): a documented, overridable tiebreak — not a hard rule.
  build: ['claude-code', 'codex'],
  research: ['codex', 'claude-code'],
};

const LABEL: Record<AgentKind, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  human: 'a person',
};

const isAgent = (k: string): k is Exclude<AgentKind, 'human'> =>
  k === 'claude-code' || k === 'codex';

const dedup = <T>(xs: T[]): T[] => xs.filter((x, i) => xs.indexOf(x) === i);

export function resolveAgent(input: AgentSelectInput): AgentChoice {
  const candidates = CANDIDATES[input.intent];
  if (!candidates) {
    // conversational / human / needs-connector never reach a coding agent.
    return {
      kind: 'human',
      via: 'none-ready',
      detail: 'Not a delegatable build or research request.',
      alternatives: [],
    };
  }

  const isReady = (k: AgentKind): boolean =>
    input.realExecution && input.runtimes.some((r) => r.id === k && r.state === 'ready');

  // An explicit operator pick wins — or is honestly reported as not ready.
  const override = input.override;
  if (override && isAgent(override)) {
    if (isReady(override)) {
      return {
        kind: override,
        via: 'override',
        detail: `Operator chose ${LABEL[override]}.`,
        alternatives: candidates.filter((k) => k !== override && isReady(k)),
      };
    }
    return notReady(input, [override], `${LABEL[override]} was chosen but is not ready.`);
  }

  const readyCandidates = candidates.filter(isReady);
  if (readyCandidates.length === 0) {
    return notReady(input, candidates, 'No coding runtime is ready.');
  }
  if (readyCandidates.length === 1) {
    const only = readyCandidates[0] as AgentKind;
    return {
      kind: only,
      via: 'only-ready',
      detail: `${LABEL[only]} is the only ready runtime.`,
      alternatives: [],
    };
  }

  // Multiple ready → policy: settings priority first, then the intent default order.
  const order = dedup([...(input.priority ?? []), ...candidates]).filter(isAgent) as AgentKind[];
  const chosen = (order.find(isReady) ?? readyCandidates[0]) as AgentKind;
  return {
    kind: chosen,
    via: 'policy',
    detail: `${LABEL[chosen]} by policy.`,
    alternatives: readyCandidates.filter((k) => k !== chosen),
  };
}

/** The honest fallback: no agent to run this, so a human does — with the fix. */
function notReady(input: AgentSelectInput, wanted: AgentKind[], detail: string): AgentChoice {
  // Surface the fix for the first wanted runtime that has one.
  const rt = wanted
    .map((k) => input.runtimes.find((r) => r.id === k))
    .find((r) => r && r.state !== 'ready');
  const names = wanted.map((k) => LABEL[k]).join(' or ');
  return {
    kind: 'human',
    via: 'none-ready',
    detail,
    missing: {
      what: `a ready coding runtime (${names})`,
      why: 'a delegated session needs an installed, authenticated agent to run',
      fix:
        rt?.detail ?? 'install and authenticate a coding runtime, then check Settings → Runtimes',
      ...(rt?.nextCommand ? { nextCommand: rt.nextCommand } : {}),
    },
    alternatives: [],
  };
}
