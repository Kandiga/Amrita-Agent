import { describe, expect, it } from 'vitest';
import { activityLine, currentActivity, pushActivity } from '../src/activity.ts';

const ev = (type: string, payload: Record<string, unknown> = {}, id = `E${type}`) => ({
  id,
  seq: 1,
  ts: '2026-07-12T10:00:00.000Z',
  type,
  payload,
});

describe('activity feed (backstage log)', () => {
  it('maps model/turn/lane/approval events to short honest lines', () => {
    expect(
      activityLine(
        ev('model.request', { provider: 'claude-code', model: 'sonnet', via: 'binding' }),
      )?.text,
    ).toBe('thinking — claude-code · sonnet (via binding)');
    expect(activityLine(ev('lane.progress', { note: 'running claude -p' }))?.text).toContain(
      'lane: running claude -p',
    );
    const wait = activityLine(
      ev('approval.requested', { action: 'lane.run-real', detail: 'build' }),
    );
    expect(wait?.tone).toBe('wait');
    expect(wait?.text).toContain('YOUR approval');
    expect(activityLine(ev('turn.failed', { error: 'boom' }))?.tone).toBe('error');
  });

  it('chat-visible noise stays out of the log', () => {
    expect(activityLine(ev('message.user', { text: 'hi' }))).toBeNull();
    expect(activityLine(ev('model.delta', { text: 'x' }))).toBeNull();
  });

  it('pushActivity de-dupes by event id and caps the ring', () => {
    let lines = pushActivity([], ev('turn.started'));
    lines = pushActivity(lines, ev('turn.started')); // same id → no dupe
    expect(lines).toHaveLength(1);
    for (let i = 0; i < 100; i++)
      lines = pushActivity(lines, ev('lane.progress', { note: `${i}` }, `P${i}`));
    expect(lines.length).toBeLessThanOrEqual(60);
  });

  it('currentActivity surfaces work/wait states and falls back to busy', () => {
    const waiting = pushActivity([], ev('approval.requested', { action: 'lane.run-real' }));
    expect(currentActivity(waiting, false)?.tone).toBe('wait');
    const done = pushActivity(waiting, ev('approval.resolved', { decision: 'allow' }, 'E2'));
    expect(currentActivity(done, false)).toBeNull();
    expect(currentActivity(done, true)?.text).toBe('working…');
  });
});
