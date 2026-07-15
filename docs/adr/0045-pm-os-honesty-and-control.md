# ADR-0045: The PM OS, part two — honesty, control, and the rest of the loop

- **Status:** Accepted
- **Date:** 2026-07-14
- **Builds on:** ADR-0044 (the agent↔domain bridge, the Inbox, the board)
- **Source:** Natanel's six-part product brief (voice). Full transcript:
  `docs/research/amrita-pm-voice-brief-2026-07-14.md`

## Context

ADR-0044 connected the agent to the domain: Amrita can now read project state and propose typed
changes, and the board's write path is live. Reviewing the work against the product brief surfaced
gaps — and **three of them were not features, they were defects**:

1. **The system silently overwrote.** The brief is explicit: *"במקרה של שני שינויים מתנגשים, המערכת
   לא דורסת בשקט. היא מזהה גרסה ישנה, מציגה קונפליקט ומבקשת הכרעה."* There was **no version check
   anywhere**. Two tabs dragging the same card ended with the last writer winning in silence. The
   brief was worse: it is a full-document upsert, so a stale save did not lose a field — it wiped
   the whole charter someone else had just written.
2. **Fact and hypothesis were indistinguishable.** *"כך אמריטה לעולם לא תערבב עובדה עם השערה."*
   Nothing recorded whether a fact was **stated** by the operator, came from a **document**, or was
   **inferred** by Amrita. A guess and a commitment looked identical on the card.
3. **The board was a template, and it appeared out of nothing.** *"היום רוב מערכות הניהול מבקשות
   ממך לפתוח פרויקט, לתת שם ואז זורקות אותך לתוך לוח ריק. אנחנו רוצים בדיוק ההפך."* Amrita created a
   project and dumped you into four hard-coded columns.

## Decision

### 1. Optimistic concurrency — the system refuses to overwrite silently

`tasks.update` and `projects.brief.update` accept `expectedVersion`. A mismatch raises the
`conflict` RPC error (a code that already existed and had **zero callers**), and the board shows
*"someone else changed this card"* with the version that actually won.

**The token is a monotonic counter, not a timestamp.** The first cut used `updatedAt`; a test caught
that two writes in the same millisecond carry the same token, so a stale write would sail straight
through the guard built to stop it. Migration `0015` adds a `version` column bumped by the reducer —
deterministic under replay, and impossible to collide.

Omitting `expectedVersion` opts out, so the CLI and the agent are unaffected.

### 2. Certainty — never mix fact with hypothesis

Migration `0013` adds `certainty ∈ {stated, documented, inferred}` to tasks, risks and questions, and
a per-field `certainty` map to the brief.

- **stated** — the operator said it. The strongest truth this system has.
- **documented** — it came from a document or an external system (the GitHub importer writes this).
- **inferred** — Amrita worked it out. **A hypothesis until a human confirms it.**

Certainty follows *who raised it*: a human capture promoted from the Inbox is `stated`; anything an
agent or a lane worked out stays `inferred` **even after you approve it** — approval makes a
proposal actionable, it does not make it first-hand. The Scribe's auto-opened question is the one
thing that enters project truth without approval, so it is always marked `inferred` and attributed.

### 3. The charter audit — the critique, as code

`charter-audit.ts` computes what a machine can determine, deterministically: a **missing** finish
line or approver, an **unconfirmed** guess sitting in the charter, and genuine **contradictions** —
two hard dates, two people approving the same area (*"התנגשות בין שני אישורים"*), a budget with
nobody authorised to spend it (*"חסר בעל תפקיד"*), everything marked negotiable, a scope item that is
also out of scope.

A prompt can *ask* a model to notice a contradiction; it cannot *guarantee* it. So the machine states
the findings and the model does the part only it can do: judge which constraint is most likely to
break the project, and say why.

### 4. Phases, and activation — the board is born from the project

Migration `0014` adds **phases** (the project's own shape) and `projects.activated_at`.

- A new project is a **conversation**, not an empty board.
- When the charter has a basis (a goal, a finish line, at least one constraint), Amrita **proposes**
  activation. Only on approval are phases, milestones and first tasks created — and the board's
  columns are **those phases**, not a template. *"הלוח לא מופיע מתוך תבנית מוכנה. הוא נולד מההקשר
  הספציפי."*
- A project with no phases falls back honestly to the four status buckets. That is not a template
  imposed on the world; it is what a board can say when the project has not told it anything else.
- `taskStatusSchema` is **still not widened** (see ADR-0044): "Waiting" remains a nullable
  `blocked_reason`.

### 5. The event explains itself

`task.updated` now carries `previous` (the FROM side, for exactly the fields that changed) and
`reason` (the why). With `origin` (who) and `ts` (when), the log answers the brief's demand in full:
*"אירוע שמספר מי הזיז, מאיזה מצב לאיזה מצב, מתי ולמה."* Migration `0016` adds `derived_from` — the
answer to *"למה הכרטיס קיים"*: the decision, constraint, risk or document it came out of.

### 6. The chat knows what you are looking at

`chat.turn` accepts an optional `focus {kind, ids}`, resolved against real rows and appended to the
context pack. *"אם פתחת סיכון, היא יודעת שאתה מדבר על הסיכון."* A focus pointing at nothing renders
nothing — never an invitation to invent.

### 7. Execution routes and delegation

`execution-route.ts` derives (never stores) one of: `do-now`, `delegate`, `needs-connector`,
`needs-approval`, `human-only`. A route depends on a runtime, a root and a connector — all of which
move — so a stored route would be a lie the moment any of them changed.

**Honesty about connectors is enforced here.** A task needing email returns exactly what is missing,
why it is needed, **and the risk of approving it** — *"מה הסיכון באישורו"*.

`tasks.delegate` hands a task to a lane: no new orchestration stack, just `lanes.start` with a goal
assembled from the task and the charter, and the `laneId` written back onto the card. **Delegation
goes through the existing approval gate, not around it.**

**Lane merge-back.** `lane.merge_report` carried typed `tasks[]`, `decisions[]` and `followUps[]`,
and the reducer **threw them away** — a lane could report that it created three tasks and zero rows
would appear. They now become Inbox proposals with `origin: 'lane'`. A lane is an agent, so it
proposes and a human disposes, exactly like the Scribe.

**`projects.setRoot`** exists at last: `root` was write-once (settable only at `createProject`, with
no `updateProject` anywhere), which is why every live project sat at `root = NULL`. The browser never
picks a path — the daemon validates it against the allowed-roots allowlist it was started with.

### 8. The weekly review — it proposes, it never acts

Two scheduler defects had to be fixed first:

- `intervalMinutes.max(24 * 60)` made **weekly literally inexpressible**. Widened to 7 days.
- run-state was an **in-memory Map**, so a restart made every job immediately due — harmless for a
  silent health check, but it would have fired a fresh review packet on every daemon bounce.
  Persisted in settings.

The job computes a packet (stale tasks, approaching and overdue milestones, blockers, unanswered
questions, open risks, recommendations) and writes **only** Inbox proposals and one `message.system`.
**A test asserts it emits no domain-mutating event at all.** Idempotent per ISO week, so even if the
run-state were lost it cannot spam a second packet.

### 9. The public stakeholder hub — SECURITY-CRITICAL

*"לא נסמוך על בקשה בנוסח 'אל תדליף', תהיה רשימת הרשאה מפורשת."*

The public object is **CONSTRUCTED from a named allowlist**, not filtered from the private one. The
distinction is the whole design: a filter is a blacklist in disguise — add a field to the brief and
it leaks by default until someone remembers to exclude it. A constructor cannot leak a field it does
not mention. There is **no `...spread` of any private object anywhere in `hub.ts`**; every value is
written out by hand.

**The model never renders it.** It cannot be prompt-injected into publishing the budget, because it
is not in the code path at all.

Publishing is approval-gated — `requestApproval` had exactly **one** caller in the entire system
(real lane runs); this is its second. *(A bug found while testing: `requestApproval` returns the
decision **string**, so `if (!allowed)` was false for `'deny'` — a truthy string — and a denied
publish would have published. Now compared explicitly against `'allow'`.)*

The public route `GET /p/<slug>` is the first hole ever punched in the auth gate, and is deliberately
the dumbest component in the system: **zero SQL on the request path**, regex-validated slug checked
before any path is constructed, realpath confinement, a CSP that forbids every outbound channel, no
directory listing, per-IP rate limit, and a revoked page that is **indistinguishable from one that
never existed** (a 404 must not become an oracle). The slug is stable across republishes — the
video's own complaint about Cloudflare Drop was that the URL changed every time.

### 10. The retrospective, and what crosses out of a project

*"הלקחים לא יזלגו אוטומטית לכל הפרויקטים. אתה תאשר מה הופך לידע ארגוני, והוא יישמר עם המקור
וההקשר."*

Cross-project learning is the most dangerous feature in a system like this: one project's hard-won
lesson is another project's confidently-wrong assumption. So the retro is **computed** from what
actually happened (dates that slipped, questions never answered, risks left open, tasks that ended
blocked), its lessons stay **inside the project** as project memory, and **promotion is one lesson at
a time, by hand**. A promoted lesson is `user`-scoped and carries `retro:<projectId>` as its source,
so the next project is always told *whose* experience it is being offered and can disagree with it.

**There is deliberately no "promote all"** — and a test asserts no such verb exists. Cross-project
contamination is not a bug you fix later; it is a door you never build.

## Consequences

Migrations `0013`–`0017`, all additive and reversible. Every new payload field is
additive-optional, so historical events replay byte-identically. Every new table is registered in
`deleteProject`'s cascade, in `rebuildProjections`' scope, and in the `REQUIRED_TABLES` fitness list.

The three defects are closed: the system no longer overwrites silently, no longer presents a guess as
a fact, and no longer conjures a board out of nothing.
