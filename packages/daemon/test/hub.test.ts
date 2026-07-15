import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type RunningHttpServer, startHttpServer } from '../src/http.ts';
import { NEVER_PUBLIC, buildPublicHub, contentHash, renderPublicHub } from '../src/hub.ts';
import { AmritaKernel } from '../src/index.ts';
import { dispatch, isErrorResponse } from '../src/rpc.ts';

/**
 * ADR-0045 slice 8 — the public stakeholder hub. SECURITY-CRITICAL.
 *
 *   "תקציב, משא ומתן, סיכונים פנימיים, הערות פרטיות, פרטי גישה והיגיון פנימי
 *    ייחסמו ברמת המערכת. לא נסמוך על בקשה בנוסח 'אל תדליף', תהיה רשימת הרשאה
 *    מפורשת."
 *
 * The leak test below is the most important test in this codebase. It builds a
 * project stuffed with everything that must never be public, publishes it, and
 * asserts that not one of those strings can be found anywhere in the bytes a
 * stranger receives.
 */

let kernel: AmritaKernel;
let ctx: { projectId: string; conversationId: string };
let dir: string;
let running: RunningHttpServer;
let base: string;

/** Every string below must be UNFINDABLE in the published page. */
const SECRETS = {
  budget: 'BUDGET-15000-NET-DO-NOT-LEAK',
  constraint: 'CONSTRAINT-third-saturday-immovable',
  approver: 'APPROVER-casey-signs-everything',
  risk: 'RISK-the-council-may-veto-us',
  question: 'QUESTION-who-actually-signs',
  decision: 'DECISION-we-lowballed-the-vendor',
  taskTitle: 'TASK-call-the-vendor-and-renegotiate',
  owner: 'OWNER-dana-is-on-leave',
  blocked: 'BLOCKED-waiting-on-the-lawyer',
  memory: 'MEMORY-the-mayor-hates-us',
  inbox: 'INBOX-someone-said-we-are-overbudget',
  noScope: 'NOSCOPE-the-after-party',
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'amrita-hub-'));
  kernel = AmritaKernel.open({ dbPath: join(dir, 'a.db'), approvalTimeoutMs: 300 });
  const projectId = kernel.ensureProject({ slug: 'f', name: 'Unity Festival' }).id;
  const conversationId = kernel.createConversation({ projectId }).id;
  ctx = { projectId, conversationId };

  kernel.upsertBrief({
    ...ctx,
    goal: 'Run the Unity Festival',
    audience: 'the town',
    finishLine: 'the festival happens',
    successCriteria: ['500 attendees'],
    noScope: [SECRETS.noScope],
    constraints: [
      { kind: 'budget', text: SECRETS.budget, hard: true },
      { kind: 'date', text: SECRETS.constraint, hard: true },
    ],
    decisionRights: [{ area: 'spend', approver: SECRETS.approver }],
  });
  kernel.activateProject({
    ...ctx,
    phases: [{ title: 'Permits' }, { title: 'The day itself' }],
    milestones: [{ title: 'Permits secured', targetDate: '2026-09-01' }],
  });

  const { taskId } = kernel.createTask({
    ...ctx,
    title: SECRETS.taskTitle,
    owner: SECRETS.owner,
  });
  kernel.updateTask({ ...ctx, taskId, blockedReason: SECRETS.blocked });
  kernel.openRisk({ ...ctx, text: SECRETS.risk, severity: 'high' });
  kernel.openQuestion({ ...ctx, text: SECRETS.question });
  kernel.recordDecision({ ...ctx, text: SECRETS.decision });
  kernel.putMemoryEntry({ ...ctx, scope: 'project', content: SECRETS.memory });
  kernel.captureInbox({ ...ctx, origin: 'user', text: SECRETS.inbox });

  running = await startHttpServer(kernel, { port: 0 });
  base = `http://127.0.0.1:${running.port}`;
});

afterEach(async () => {
  await running.close();
  kernel.close();
  rmSync(dir, { recursive: true, force: true });
});

async function rpc(method: string, params: unknown): Promise<unknown> {
  const r = await dispatch(kernel, { id: 1, method, params });
  if (isErrorResponse(r)) throw new Error(`${r.error.code}|${r.error.message}`);
  return r.result;
}

/** Publish, approving the gate when it opens. */
async function publish(): Promise<{ slug: string; url: string }> {
  const done = kernel.publishHub({ ...ctx, origin: 'user' });
  // The approval broker parks the request; approve it.
  await new Promise((r) => setTimeout(r, 20));
  const pending = kernel.listPendingApprovals();
  expect(pending[0]?.action).toBe('hub.publish');
  kernel.resolveApproval(pending[0]?.approvalId ?? '', 'allow');
  return (await done) as { slug: string; url: string };
}

describe('the allowlist is a CONSTRUCTOR, not a filter (ADR-0045)', () => {
  it('the public shape has EXACTLY these keys — adding a private field cannot widen it', () => {
    const hub = buildPublicHub({
      project: { name: 'x' },
      brief: null,
      milestones: [],
      phases: [],
      tasks: [],
      updates: [],
      generatedAt: '2026-07-14T00:00:00.000Z',
    });
    // If someone adds a field to PublicHub, this fails — which is the point. A new
    // public field must be a DELIBERATE act, reviewed here.
    expect(Object.keys(hub).sort()).toEqual([
      'audience',
      'finishLine',
      'generatedAt',
      'goal',
      'milestones',
      'phases',
      'progress',
      'projectName',
      'updates',
    ]);
  });

  it('the NEVER_PUBLIC denylist is ENFORCED, not just documented', () => {
    // The denylist named the fields that must never reach a stranger, but nothing
    // read it — it was a comment with a const's clothes. Now it is a test: not one
    // of those names may appear as a key of the constructed public object, at the
    // top level or nested (milestones/phases/updates/progress).
    const hub = buildPublicHub({
      project: { name: 'x' },
      brief: null,
      milestones: [],
      phases: [],
      tasks: [],
      updates: [],
      generatedAt: '2026-07-14T00:00:00.000Z',
    });
    const allKeys = new Set<string>();
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) {
        for (const x of v) walk(x);
      } else if (v && typeof v === 'object') {
        for (const [k, val] of Object.entries(v)) {
          allKeys.add(k);
          walk(val);
        }
      }
    };
    walk(hub);
    for (const banned of NEVER_PUBLIC) {
      expect(allKeys.has(banned)).toBe(false);
    }
  });

  it('publishes progress as a COUNT, never as a list of task titles', () => {
    const hub = buildPublicHub({
      project: { name: 'x' },
      brief: null,
      milestones: [],
      phases: [],
      tasks: [
        { status: 'done', title: 'secret task a' } as never,
        { status: 'now', title: 'secret task b' } as never,
      ],
      updates: [],
      generatedAt: '2026-07-14T00:00:00.000Z',
    });
    expect(hub.progress).toEqual({ done: 1, total: 2 });
    expect(JSON.stringify(hub)).not.toContain('secret task');
  });

  it('the content hash ignores generatedAt — a preview is not a change', () => {
    const base = {
      project: { name: 'x' },
      brief: null,
      milestones: [],
      phases: [],
      tasks: [],
      updates: [],
    };
    const a = buildPublicHub({ ...base, generatedAt: '2026-07-14T00:00:00.000Z' });
    const b = buildPublicHub({ ...base, generatedAt: '2026-07-15T00:00:00.000Z' });
    expect(contentHash(JSON.stringify({ ...a, generatedAt: '' }))).toBe(
      contentHash(JSON.stringify({ ...b, generatedAt: '' })),
    );
  });

  it('escapes HTML — a project name cannot inject script into a stakeholder page', () => {
    const html = renderPublicHub(
      buildPublicHub({
        project: { name: '<script>alert(1)</script>' },
        brief: null,
        milestones: [],
        phases: [],
        tasks: [],
        updates: [],
        generatedAt: '2026-07-14T00:00:00.000Z',
      }),
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('THE LEAK TEST — nothing internal can reach a stranger (ADR-0045)', () => {
  it('publishes, and not one internal string is in the bytes the public receives', async () => {
    const { slug } = await publish();

    const res = await fetch(`${base}/p/${slug}`);
    expect(res.status).toBe(200);
    const html = await res.text();

    // What the world IS allowed to see.
    expect(html).toContain('Unity Festival');
    expect(html).toContain('Run the Unity Festival');
    expect(html).toContain('Permits secured');
    expect(html).toContain('The day itself');

    // What it must NEVER see. Every one of these is in the project.
    for (const [what, secret] of Object.entries(SECRETS)) {
      expect(html, `LEAKED ${what}`).not.toContain(secret);
    }
    // …and no stray private vocabulary either.
    expect(html.toLowerCase()).not.toContain('budget');
    expect(html.toLowerCase()).not.toContain('risk');
    expect(html.toLowerCase()).not.toContain('decision');
  });

  it('the public page makes NO external requests — it cannot phone home', async () => {
    const { slug } = await publish();
    const html = await (await fetch(`${base}/p/${slug}`)).text();
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\//i); // no fonts, no CDNs, no analytics
    const csp = (await fetch(`${base}/p/${slug}`)).headers.get('content-security-policy');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("form-action 'none'");
  });
});

describe('the public route is the dumbest component in the system (ADR-0045)', () => {
  it('is reachable with NO bearer token — while /rpc still is not', async () => {
    const { slug } = await publish();
    expect((await fetch(`${base}/p/${slug}`)).status).toBe(200);
  });

  it('404s an unknown slug — and never says whether it once existed', async () => {
    const r = await fetch(`${base}/p/${'a'.repeat(22)}`);
    expect(r.status).toBe(404);
    expect(await r.text()).toBe('not found');
  });

  it('rejects traversal and short slugs BEFORE touching the filesystem', async () => {
    expect((await fetch(`${base}/p/../../etc/passwd`)).status).not.toBe(200);
    expect((await fetch(`${base}/p/short`)).status).toBe(404);
    expect(kernel.readPublishedHub('../../etc/passwd')).toBeNull();
    expect(kernel.readPublishedHub('short')).toBeNull();
  });

  it('a revoked page 404s, and looks exactly like one that never existed', async () => {
    const { slug } = await publish();
    expect((await fetch(`${base}/p/${slug}`)).status).toBe(200);

    kernel.revokeHub({ ...ctx, reason: 'the festival was cancelled' });

    const revoked = await fetch(`${base}/p/${slug}`);
    const never = await fetch(`${base}/p/${'z'.repeat(22)}`);
    expect(revoked.status).toBe(404);
    expect(await revoked.text()).toBe(await never.text()); // no oracle
  });
});

describe('publishing is consequential, so it is gated (ADR-0045)', () => {
  it('requires approval — and a DENY publishes nothing', async () => {
    const attempt = kernel.publishHub({ ...ctx });
    await new Promise((r) => setTimeout(r, 20));
    const pending = kernel.listPendingApprovals();
    expect(pending[0]?.action).toBe('hub.publish');
    kernel.resolveApproval(pending[0]?.approvalId ?? '', 'deny');

    await expect(attempt).rejects.toThrow(/not approved/i);
    expect(kernel.previewHub(ctx.projectId).published).toBeNull();
  });

  it('the URL is STABLE across republishes — the video complained that Drop changed it', async () => {
    const first = await publish();
    kernel.createTask({ ...ctx, title: 'something new' });
    const second = await publish();
    expect(second.slug).toBe(first.slug);
  });

  it('preview says when the published page has drifted out of sync', async () => {
    await publish();
    expect(kernel.previewHub(ctx.projectId).published?.inSync).toBe(true);

    kernel.createMilestone({ ...ctx, title: 'A new milestone the public has not seen' });
    expect(kernel.previewHub(ctx.projectId).published?.inSync).toBe(false);
  });

  it('previewing publishes NOTHING', async () => {
    await rpc('projects.hub.preview', { projectId: ctx.projectId });
    expect(kernel.previewHub(ctx.projectId).published).toBeNull();
  });

  it('both publish and revoke are on the audit log', async () => {
    await publish();
    kernel.revokeHub({ ...ctx, reason: 'done with it' });
    const types = kernel.listEvents(ctx.conversationId, 0).map((e) => e.type);
    expect(types).toContain('publication.published');
    expect(types).toContain('publication.revoked');
    expect(types).toContain('approval.requested');
  });
});
