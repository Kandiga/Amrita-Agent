/**
 * The public stakeholder hub (ADR-0045). SECURITY-CRITICAL.
 *
 * From the product brief (voice, file 05):
 *
 *   "המרכז הציבורי יהיה תצוגה נגזרת ומאושרת של מצב הפרויקט, לא מסמך שהמודל יכול
 *    למלא בחופשיות… תקציב, משא ומתן, סיכונים פנימיים, הערות פרטיות, פרטי גישה
 *    והיגיון פנימי ייחסמו ברמת המערכת. **לא נסמוך על בקשה בנוסח "אל תדליף"**,
 *    תהיה רשימת הרשאה מפורשת."
 *
 * That sentence is the entire design. The public object is **CONSTRUCTED from a
 * named allowlist**, not filtered from the private one. The difference matters more
 * than it sounds:
 *
 *   - a filter is a blacklist wearing a disguise: add a field to the brief and it
 *     leaks by default until someone remembers to exclude it;
 *   - a constructor cannot leak a field it does not mention. A new private field is
 *     invisible here **by construction**, and making it public requires editing this
 *     file AND the test that pins the exact key set.
 *
 * The model never renders this. It cannot be prompt-injected into publishing the
 * budget, because it is not in the code path at all.
 *
 * Pure: injected inputs, no clock, no store, no network.
 */
import type { MilestoneRow, PhaseRow, ProjectBriefRow, TaskRow } from '@amrita/store';

/**
 * EVERY field a stakeholder may ever see. If it is not here, it cannot be
 * published. A test asserts the rendered key set equals exactly this shape.
 */
export interface PublicHub {
  projectName: string;
  /** The goal, in the operator's own words. */
  goal: string;
  /** Who it is for. Optional — absent is fine, invented is not. */
  audience: string | null;
  /** What "done" means. Public because stakeholders deserve to know when it ends. */
  finishLine: string | null;
  /** Milestones in plain language: title, whether it is done, and when. */
  milestones: {
    title: string;
    status: 'planned' | 'in-progress' | 'done';
    targetDate: string | null;
  }[];
  /** Phases, as a plain-language roadmap. */
  phases: { title: string; status: 'planned' | 'in-progress' | 'done' }[];
  /** Progress as a COUNT, never as a task list — titles leak internal detail. */
  progress: { done: number; total: number };
  /** Updates the operator explicitly approved for publication. */
  updates: { date: string; text: string }[];
  /** Generated at (ISO). Stakeholders need to know how fresh this is. */
  generatedAt: string;
}

/**
 * NEVER public. Listed explicitly so the intent is greppable and reviewable, and so
 * a future reader cannot mistake omission for oversight:
 *
 *   budget · constraints · decision rights · negotiations · the risk register ·
 *   open questions · decisions · task titles/owners/bodies · blocked reasons ·
 *   project memory · the Inbox · lanes · receipts · brand do-not-use · any event
 *   payload · secrets (which are not in the store at all — ADR-0008)
 *
 * None of these appear in `PublicHub`. This list is not decoration: hub.test.ts
 * walks the constructed public object and asserts not one of these names appears
 * as a key, at any depth — so the denylist is enforced, not merely documented.
 */
export const NEVER_PUBLIC = [
  'budget',
  'constraints',
  'decisionRights',
  'risks',
  'questions',
  'decisions',
  'taskTitles',
  'owners',
  'blockedReasons',
  'memory',
  'inbox',
  'lanes',
  'events',
] as const;

export interface HubInput {
  project: { name: string };
  brief: ProjectBriefRow | null;
  milestones: readonly MilestoneRow[];
  phases: readonly PhaseRow[];
  tasks: readonly TaskRow[];
  /** Only updates the operator approved. Nothing is published implicitly. */
  updates: readonly { date: string; text: string }[];
  generatedAt: string;
}

const publicStatus = (s: string): 'planned' | 'in-progress' | 'done' =>
  s === 'done' ? 'done' : s === 'active' ? 'in-progress' : 'planned';

/**
 * Build the public view. Reads ONLY the fields named in `PublicHub`.
 *
 * Note what is NOT here: no `...spread` of any private object, anywhere. Every
 * value is written out by hand. That is deliberate — a spread is how a private
 * field ends up public by accident.
 */
export function buildPublicHub(input: HubInput): PublicHub {
  const b = input.brief;
  const live = input.milestones.filter((m) => m.status !== 'dropped');
  const livePhases = input.phases.filter((p) => p.status !== 'dropped');
  const countable = input.tasks.filter((t) => t.status !== 'dropped');

  return {
    projectName: input.project.name,
    goal: b?.goal ?? '',
    audience: b?.audience ?? null,
    finishLine: b?.finishLine ?? null,
    milestones: live.map((m) => ({
      title: m.title,
      status: publicStatus(m.status),
      targetDate: m.targetDate,
    })),
    phases: livePhases.map((p) => ({ title: p.title, status: publicStatus(p.status) })),
    progress: {
      done: countable.filter((t) => t.status === 'done').length,
      total: countable.length,
    },
    updates: input.updates.map((u) => ({ date: u.date, text: u.text })),
    generatedAt: input.generatedAt,
  };
}

/** FNV-1a — the same change-detection digest ADR-0020 uses for previews. */
export function contentHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function esc(s: string): string {
  // Every current interpolation site is a text node or a double-quoted/enum/numeric
  // attribute, so `'` is not strictly required today. It is escaped anyway so that a
  // future edit placing user text in a single-quoted or unquoted attribute cannot
  // silently become an injection with no test to catch it.
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render the hub as ONE self-contained HTML file.
 *
 * No external requests of any kind: no fonts, no scripts, no images, no analytics.
 * A stakeholder page that phones home is a stakeholder page that leaks who read it
 * and when. `dir="auto"` throughout, because the content may be Hebrew.
 */
export function renderPublicHub(hub: PublicHub): string {
  const milestones = hub.milestones
    .map(
      (m) =>
        `<li class="${m.status}"><span class="dot"></span><div><strong dir="auto">${esc(m.title)}</strong>${
          m.targetDate ? `<time>${esc(m.targetDate)}</time>` : ''
        }<em>${m.status === 'done' ? 'done' : m.status === 'in-progress' ? 'in progress' : 'planned'}</em></div></li>`,
    )
    .join('');

  const phases = hub.phases
    .map((p) => `<li class="${p.status}" dir="auto">${esc(p.title)}</li>`)
    .join('');

  const updates = hub.updates
    .map((u) => `<li><time>${esc(u.date)}</time><p dir="auto">${esc(u.text)}</p></li>`)
    .join('');

  const pct =
    hub.progress.total > 0 ? Math.round((hub.progress.done / hub.progress.total) * 100) : 0;

  return `<!doctype html>
<html lang="en" dir="auto">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(hub.projectName)}</title>
<style>
  :root { --ink:#141413; --slate:#3d3d3a; --stone:#87867f; --line:#e5e4df; --paper:#faf9f5; --clay:#d97757; }
  * { box-sizing: border-box; }
  body { margin:0; padding:48px 20px; background:var(--paper); color:var(--ink);
         font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { max-width: 680px; margin: 0 auto; }
  h1 { font-size: 30px; margin: 0 0 6px; }
  .goal { font-size: 18px; color: var(--slate); margin: 0 0 4px; }
  .aud, .fin { color: var(--stone); margin: 0 0 4px; font-size: 14px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing:.06em; color: var(--stone);
       margin: 36px 0 12px; font-weight: 600; }
  ul { list-style: none; margin: 0; padding: 0; }
  .ms li { display:flex; gap:12px; padding:10px 0; border-bottom:1px solid var(--line); }
  .ms .dot { width:9px; height:9px; border-radius:50%; margin-top:8px; flex:0 0 auto;
             background:var(--line); border:1px solid var(--stone); }
  .ms li.done .dot { background: var(--clay); border-color: var(--clay); }
  .ms li.in-progress .dot { background: var(--paper); border-color: var(--clay); }
  .ms time { display:block; color:var(--stone); font-size:13px; }
  .ms em { color: var(--stone); font-size:12px; font-style:normal; }
  .ph li { display:inline-block; border:1px solid var(--line); border-radius:999px;
           padding:3px 12px; margin:0 6px 6px 0; font-size:13px; color: var(--slate); }
  .ph li.done { color: var(--clay); border-color: var(--clay); }
  .bar { height:6px; background:var(--line); border-radius:3px; overflow:hidden; }
  .bar > i { display:block; height:100%; background:var(--clay); }
  .prog { color: var(--stone); font-size:13px; margin-top:6px; }
  .up li { padding: 10px 0; border-bottom: 1px solid var(--line); }
  .up time { color: var(--stone); font-size: 13px; }
  .up p { margin: 4px 0 0; }
  footer { margin-top: 44px; color: var(--stone); font-size: 12px; }
</style>
<main>
  <h1 dir="auto">${esc(hub.projectName)}</h1>
  ${hub.goal ? `<p class="goal" dir="auto">${esc(hub.goal)}</p>` : ''}
  ${hub.audience ? `<p class="aud" dir="auto">For ${esc(hub.audience)}</p>` : ''}
  ${hub.finishLine ? `<p class="fin" dir="auto">Done means: ${esc(hub.finishLine)}</p>` : ''}

  ${
    hub.progress.total > 0
      ? `<h2>Progress</h2>
  <div class="bar"><i style="width:${pct}%"></i></div>
  <p class="prog">${hub.progress.done} of ${hub.progress.total} complete</p>`
      : ''
  }

  ${phases ? `<h2>Roadmap</h2><ul class="ph">${phases}</ul>` : ''}
  ${milestones ? `<h2>Milestones</h2><ul class="ms">${milestones}</ul>` : ''}
  ${updates ? `<h2>Updates</h2><ul class="up">${updates}</ul>` : ''}

  <footer>Published ${esc(hub.generatedAt.slice(0, 10))} · this page is a summary, not a live view</footer>
</main>
</html>`;
}

/** The slug pattern. Opaque, high-entropy, unguessable, unrelated to the ULID. */
export const SLUG_RE = /^[A-Za-z0-9_-]{16,64}$/;
