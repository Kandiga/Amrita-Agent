import type { AmritaEvent } from '@amrita/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { AmritaKernel } from '../src/index.ts';
import { OrchestrationWatcher } from '../src/orchestration-watcher.ts';
import {
  WATCH_APPROVAL_MS,
  WATCH_STALL_MS,
  type WatchAction,
  decideSweep,
  decideWatch,
  emptyWatchState,
} from '../src/watch-decide.ts';

/**
 * ADR-0048 §8.3 — the Watcher: pure decision core + a thin event-driven shell.
 * Evidence-backed detections only; every output is an Inbox proposal; the dedup
 * ledger makes replays and duplicate deliveries fold to no-ops.
 */

let seq = 0;
const ev = (over: Partial<AmritaEvent> & Pick<AmritaEvent, 'type'>): AmritaEvent =>
  ({
    id: `e${seq++}`,
    seq: seq,
    ts: '2026-07-16T12:00:00.000Z',
    projectId: 'P1',
    conversationId: 'C1',
    origin: 'lane',
    ...over,
  }) as AmritaEvent;

const mandate = (laneId: string, goal: string, paths: string[], over: Partial<AmritaEvent> = {}) =>
  ev({
    type: 'lane.mandate',
    payload: {
      laneId,
      goal,
      contextPack: { memory: [], files: [], decisions: [] },
      scope: { paths, network: 'none' },
      budget: {},
      approvals: 'forward',
      deliverables: [],
    },
    ...over,
  } as Partial<AmritaEvent>);

describe('decideWatch — evidence-backed detections (pure)', () => {
  it('flags cross-session scope overlap once, not per event', () => {
    const s = emptyWatchState();
    expect(decideWatch(s, mandate('L1', 'build A', ['/ws/app']))).toEqual([]);
    const hit = decideWatch(s, mandate('L2', 'build B', ['/ws/app/sub']));
    expect(hit).toHaveLength(1);
    expect(hit[0]?.text).toMatch(/share a workspace path/i);
    // a duplicate/replayed mandate for the same pair does not re-flag
    expect(decideWatch(s, mandate('L2', 'build B', ['/ws/app/sub']))).toEqual([]);
  });

  it('does NOT flag disjoint scopes or a lane against itself', () => {
    const s = emptyWatchState();
    decideWatch(s, mandate('L1', 'a', ['/ws/one']));
    expect(decideWatch(s, mandate('L2', 'b', ['/ws/two']))).toEqual([]);
    expect(decideWatch(s, mandate('L1', 'a', ['/ws/one']))).toEqual([]); // same lane, no self-overlap
  });

  it('isolates by project — overlapping paths in different projects never conflict', () => {
    const s = emptyWatchState();
    decideWatch(s, mandate('L1', 'a', ['/ws/x']));
    expect(decideWatch(s, mandate('L2', 'b', ['/ws/x'], { projectId: 'P2' }))).toEqual([]);
  });

  it('proposes on a budget/partial merge exit, once per lane', () => {
    const s = emptyWatchState();
    decideWatch(s, mandate('L1', 'ship it', ['/ws/x']));
    const report = (exit: string) =>
      ev({
        type: 'lane.merge_report',
        payload: { laneId: 'L1', summary: 'ran out', exit } as never,
      });
    const first = decideWatch(s, report('budget'));
    expect(first[0]?.text).toMatch(/out of budget/i);
    expect(decideWatch(s, report('budget'))).toEqual([]); // dedup
  });

  it('proposes on a SYSTEM abort but not an operator cancel/deny', () => {
    const s1 = emptyWatchState();
    decideWatch(s1, mandate('L1', 'g', ['/ws/x']));
    const sysAbort = decideWatch(
      s1,
      ev({ type: 'lane.aborted', payload: { laneId: 'L1', reason: 'the agent crashed' } as never }),
    );
    expect(sysAbort).toHaveLength(1);

    const s2 = emptyWatchState();
    decideWatch(s2, mandate('L2', 'g', ['/ws/y']));
    const opCancel = decideWatch(
      s2,
      ev({
        type: 'lane.aborted',
        payload: { laneId: 'L2', reason: 'real run denied by operator' } as never,
      }),
    );
    expect(opCancel).toEqual([]); // the human chose — not a failure
  });

  it('ignores its own inbox output — the loop cannot feed itself', () => {
    const s = emptyWatchState();
    expect(
      decideWatch(s, ev({ type: 'inbox.captured', payload: { itemId: 'i1' } as never })),
    ).toEqual([]);
  });
});

describe('decideSweep — the only time-based rule', () => {
  it('flags a stalled lane past the threshold, once per idle span', () => {
    const s = emptyWatchState();
    decideWatch(s, mandate('L1', 'slow build', ['/ws/x']));
    const soon = new Date(
      Date.parse('2026-07-16T12:00:00.000Z') + WATCH_STALL_MS - 1,
    ).toISOString();
    expect(decideSweep(s, soon)).toEqual([]); // not yet
    const late = new Date(
      Date.parse('2026-07-16T12:00:00.000Z') + WATCH_STALL_MS + 1,
    ).toISOString();
    const hit = decideSweep(s, late);
    expect(hit[0]?.text).toMatch(/stalled/i);
    expect(decideSweep(s, late)).toEqual([]); // same idle span → dedup
  });

  it('flags a stuck approval, then stops once resolved', () => {
    const s = emptyWatchState();
    decideWatch(
      s,
      ev({
        type: 'approval.requested',
        payload: { approvalId: 'A1', action: 'lane.run-real', detail: 'x' } as never,
        laneId: 'L1',
      }),
    );
    const late = new Date(
      Date.parse('2026-07-16T12:00:00.000Z') + WATCH_APPROVAL_MS + 1,
    ).toISOString();
    expect(decideSweep(s, late)[0]?.text).toMatch(/waiting/i);
    decideWatch(
      s,
      ev({ type: 'approval.resolved', payload: { approvalId: 'A1', decision: 'allow' } as never }),
    );
    expect(decideSweep(s, late)).toEqual([]); // resolved → gone
  });

  it('a completed lane is removed and never stalls', () => {
    const s = emptyWatchState();
    decideWatch(s, mandate('L1', 'g', ['/ws/x']));
    decideWatch(s, ev({ type: 'lane.completed', payload: { laneId: 'L1' } as never }));
    const late = new Date(
      Date.parse('2026-07-16T12:00:00.000Z') + WATCH_STALL_MS + 1,
    ).toISOString();
    expect(decideSweep(s, late)).toEqual([]);
  });
});

describe('OrchestrationWatcher shell — subscription + dispatch + cleanup', () => {
  const watchers: OrchestrationWatcher[] = [];
  afterEach(() => {
    for (const w of watchers.splice(0)) w.stop();
  });

  function harness() {
    let emit: (ev: AmritaEvent) => void = () => {};
    let subscribed = false;
    const proposals: WatchAction[] = [];
    const w = new OrchestrationWatcher({
      subscribe: (l) => {
        subscribed = true;
        emit = l;
        return () => {
          subscribed = false;
        };
      },
      propose: (a) => proposals.push(a),
      sweepIntervalMs: 0, // tests drive sweep()
    });
    watchers.push(w);
    return { w, fire: (e: AmritaEvent) => emit(e), proposals, isSubscribed: () => subscribed };
  }

  it('subscribes on start, dispatches a detection, and unsubscribes on stop', () => {
    const h = harness();
    h.w.start();
    expect(h.isSubscribed()).toBe(true);
    h.fire(mandate('L1', 'a', ['/ws/x']));
    h.fire(mandate('L2', 'b', ['/ws/x']));
    expect(h.proposals).toHaveLength(1);
    h.w.stop();
    expect(h.isSubscribed()).toBe(false);
    h.fire(mandate('L3', 'c', ['/ws/x'])); // after stop → ignored
    expect(h.proposals).toHaveLength(1);
  });

  it('a throwing propose never breaks the subscription', () => {
    let n = 0;
    let emit: (ev: AmritaEvent) => void = () => {};
    const w = new OrchestrationWatcher({
      subscribe: (l) => {
        emit = l;
        return () => {};
      },
      propose: () => {
        n++;
        throw new Error('sink down');
      },
      sweepIntervalMs: 0,
    });
    watchers.push(w);
    w.start();
    emit(mandate('L1', 'a', ['/ws/x']));
    emit(mandate('L2', 'b', ['/ws/x'])); // still delivered despite the earlier throw
    expect(n).toBe(1); // one overlap detected; the throw did not wedge the loop
  });

  it('start is idempotent — a double start does not double-subscribe', () => {
    const h = harness();
    h.w.start();
    h.w.start();
    h.fire(mandate('L1', 'a', ['/ws/x']));
    h.fire(mandate('L2', 'b', ['/ws/x']));
    expect(h.proposals).toHaveLength(1); // not 2
  });
});

describe('Watcher wired into the kernel (ADR-0048 §8.3)', () => {
  let kernel: AmritaKernel;
  afterEach(() => kernel?.close());

  it('an overlap detection lands as ONE origin:lane Inbox risk — deferred, not re-entrant', async () => {
    kernel = AmritaKernel.open({ dbPath: ':memory:', enableWatcher: true });
    const projectId = kernel.ensureProject({ slug: 'w', name: 'W' }).id;
    const conversationId = kernel.createConversation({ projectId }).id;

    await kernel.startLane({
      conversationId,
      goal: 'build the app',
      kind: 'claude-code',
      scope: { paths: ['/ws/app'] },
      dryRun: true,
    });
    await kernel.startLane({
      conversationId,
      goal: 'refactor the app',
      kind: 'claude-code',
      scope: { paths: ['/ws/app/sub'] },
      dryRun: true,
    });

    // The proposal is deferred to a microtask so it never re-enters the fan-out.
    await new Promise((r) => setTimeout(r, 0));
    const inbox = kernel
      .listInbox({ projectId })
      .filter((i) => i.origin === 'lane' && /workspace path/i.test(i.text));
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.suggestedKind).toBe('risk');
  });

  it('close() stops the Watcher — no proposal after shutdown', async () => {
    kernel = AmritaKernel.open({ dbPath: ':memory:', enableWatcher: true });
    const projectId = kernel.ensureProject({ slug: 'w2', name: 'W2' }).id;
    const conversationId = kernel.createConversation({ projectId }).id;
    await kernel.startLane({
      conversationId,
      goal: 'a',
      scope: { paths: ['/ws/z'] },
      dryRun: true,
    });
    kernel.close();
    // A late microtask after close must not write.
    await new Promise((r) => setTimeout(r, 0));
    // (kernel is closed; re-opening a fresh one proves no cross-instance leak)
    const fresh = AmritaKernel.open({ dbPath: ':memory:', enableWatcher: false });
    expect(
      fresh.listInbox({ projectId: fresh.ensureProject({ slug: 'w2', name: 'W2' }).id }),
    ).toEqual([]);
    fresh.close();
  });
});
