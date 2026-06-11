# ADR-0021: operator mode — approval broker and the Telegram runner

- **Status:** Accepted
- **Date:** 2026-06-11
- **Context:** The roadmap's Operator Mode stage: Natanel supervises projects from a phone —
  status, lane progress, and above all *approvals* for dangerous actions. The protocol has
  carried `approval.requested/resolved` since Phase 0, unused; the Telegram transport and
  owner allowlist have been tested since Phase 3 but no live runner shipped. This ADR wires
  both into a real supervision loop.

## Decision

### 1. The approval broker (kernel)
`requestApproval(ctx, action, detail?)` emits `approval.requested` (the audit record), parks a
pending entry in kernel-runtime state, and resolves on exactly one of:

- **explicit decision** via `resolveApproval` (`approvals.resolve` RPC — web, Telegram, future
  CLI all converge here);
- **timeout** (`KernelOptions.approvalTimeoutMs`, default 120 s) — **denied by default** and
  audited as `approval.resolved {decision: 'deny'}`;
- **abort signal** (e.g. the lane is cancelled) — treated as deny.

Pending entries are runtime state (`approvals.list`); the event log is the durable audit trail.
Nothing is persisted as "pending" across restarts — an approval that outlives its daemon was
never granted, which is exactly the deny-by-default posture.

### 2. The first gated action: REAL lane runs
A `lanes.start {real: true}` on an opted-in daemon, under the mandate's **default
`approvals: 'forward'` policy**, now pauses before anything executes: the lane emits a
progress note ("awaiting operator approval"), raises `lane.run-real` with the goal as detail,
and proceeds only on allow. Deny/timeout/cancel abort the lane with the reason — the runner is
never invoked. `'auto-safe'`/`'sandboxed'` policies skip the gate (an explicit pre-
authorization). **Behavior change:** previously a real start ran immediately; tests that want
the old behavior pass `approvals: 'auto-safe'`. Dry runs and safe (non-real) runs are never
gated.

### 3. Telegram operator commands
Paired, allowlisted owners get `/status` (brief goal, open tasks/questions/risks, active
lanes, pending approvals), `/lanes`, `/approvals`, `/approve <id-prefix>` / `/deny <id-prefix>`
(project-scoped, ambiguity-guarded, case-insensitive prefixes), `/stop <lane>`, `/help`.
Everything reads/writes through the kernel's typed surface; replies never carry secrets.
Approvals from other projects are invisible to a paired chat.

### 4. The live runner (strictly opt-in)
`startTelegramRunner` long-polls the **official Bot API** with an injectable fetch. It starts
only via `amritad --telegram`, refuses without `TELEGRAM_BOT_TOKEN` (env name in the error,
never the value) and refuses an empty `AMRITA_TELEGRAM_ALLOWED_IDS` (deny-by-default). The
token is read once into the runner closure — never logged, stored, or returned. The kernel
tracks live runners (`markChannelRunnerActive`) so `channels.list` and doctor report telegram
as `ready` **only while the runner actually runs**; otherwise `needs_setup` with the exact env
names. Transient poll failures back off and never crash the daemon; tests use injected
transports and a clearly-fake token fixture.

### 5. Accepted debt: the daemon ⇄ channels manifest cycle
The runner must live in the daemon process (pending approvals are kernel-runtime state), so
the `amritad` bin dynamically imports `@amrita/channels`, which itself depends on
`@amrita/daemon` for the kernel type. pnpm tolerates the workspace cycle; it is bin-only and
will be broken by extracting a `ChannelHost` interface when a second channel runner lands.

## Consequences
The supervision loop is closed end-to-end: a dangerous action raises a request that is visible
and resolvable from web and phone, unanswered requests fail safe, and every decision is in the
replayable log. Future gated actions (deployments, tool approvals per the tool-registry stage,
broader lane permissions) reuse `requestApproval` unchanged.
