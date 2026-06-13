# Spec: the `amrita` CLI

`@amrita/cli` is a local command-line client for the amritad kernel. It speaks the JSON-RPC layer
**in process** (it opens a kernel on `--db` and dispatches directly — no subprocess), so it is fast
and deterministic. See [ADR-0009](../adr/0009-amritad-kernel-and-rpc.md) for the RPC boundary.

**No provider calls, chat turn loop, or tool/lane execution run here** — this CLI operates the store
and config surfaces only.

## Invocation

```bash
pnpm amrita -- <command> [args] [--db <PATH>] [--json]
# or directly:
node packages/cli/src/bin/amrita.ts health
```

`--db <PATH>` is **optional** since ADR-0024: it defaults to `~/.amrita/amrita.db` (override the
home with `AMRITA_HOME`; use `:memory:` for a throwaway DB). The DB is opened and migrated on each
invocation and closed on exit; state persists when the DB is a file path. The `amrita` executable
also loads `~/.amrita/secrets.env` (machine-local, 0600) into unset env vars at startup — real
process env always wins, and the in-process `run()` used by tests never loads it.

- **Exit codes:** `0` success · `1` RPC failure · `2` usage/validation error.
- **Output:** concise human text by default; `--json` emits the raw JSON result (or `{error:{…}}`).
- Errors never print a stack trace or a secret value.

## Commands

```bash
amrita setup [section]         # sectioned wizard (ADR-0026): brain|roles|runtime|channels|
                               #   service|agent|tools; --full reconfigures all (with backup)
amrita model                   # shared brain/model picker (same flow as `setup brain`)
amrita provider catalog        # full chooser catalog with live, honest states
amrita provider models <id>    # discover models (live /models, curated fallback)
amrita doctor --fix            # tighten home (0700) + secret/config (0600) permissions
amrita setup                   # first-run wizard (ADR-0024/0025): grouped brain chooser —
                               #   subscription login (Claude Code), API keys (Anthropic/OpenAI/
                               #   OpenRouter/Gemini), local OpenAI-compatible endpoint — then telegram.
                               #   Re-run any time to change brains; states are live-probed and honest.
amrita health --db PATH
amrita doctor --db PATH        # grouped ◆ checks, ✓/!/✗ marks, numbered exact-fix footer

amrita project ensure <slug> [--name NAME] --db PATH      # create-or-get
amrita project list --db PATH

amrita conversation create --project <ID_OR_SLUG> [--title T] [--parent ID] --db PATH
amrita conversation tree <CONVERSATION_ID> --db PATH

amrita message user <CONVERSATION_ID> <TEXT> --db PATH

amrita task create --project <ID_OR_SLUG> --title TITLE [--conversation ID] --db PATH
amrita task list --project <ID_OR_SLUG> --db PATH
amrita task complete <TASK_ID> --db PATH

amrita decision record --project <ID_OR_SLUG> --text TEXT [--conversation ID] --db PATH

amrita brief get --project <ID_OR_SLUG> --db PATH
amrita brief set --project <ID_OR_SLUG> --goal TEXT [--audience TEXT] [--criteria a;b] [--scope a;b] [--no-scope a;b] --db PATH
amrita question list|open|resolve|drop ... --project <ID_OR_SLUG> --db PATH   # resolve needs --note or --decision; drop needs --reason
amrita risk list|open|resolve|drop ... --project <ID_OR_SLUG> [--severity low|medium|high] --db PATH
amrita milestone list|create|complete ... --project <ID_OR_SLUG> [--target YYYY-MM-DD] --db PATH
amrita timeline --project <ID_OR_SLUG> [--limit N] --db PATH   # newest-first, derived from the event log

amrita memory put --scope user|project --content TEXT [--project ID_OR_SLUG] --db PATH
amrita memory search <QUERY> [--scope user|project] [--project ID_OR_SLUG] --db PATH

amrita account connect --provider PROVIDER [--label LABEL] [--auth-mode MODE] --db PATH
amrita account bind-secret <ACCOUNT_ID> <ENV_NAME> --db PATH
amrita account status <ACCOUNT_ID> --db PATH

amrita chat <TEXT> [--project ID_OR_SLUG] [--conversation ID] [--provider mock] [--role fast|main|deep] [--model MODEL] --db PATH
amrita provider list --db PATH
amrita role list --db PATH                                 # fast/main/deep → provider [binding|auto]
amrita role set <fast|main|deep> <provider> [--model M] --db PATH
amrita role clear <fast|main|deep> --db PATH               # back to auto

amrita lane list [--project ID_OR_SLUG] [--conversation ID] [--status STATUS] --db PATH
amrita lane start --goal TEXT [--project ID_OR_SLUG] [--conversation ID] [--kind claude-code] [--dry-run] [--real] --db PATH
amrita lane get <LANE_ID> --db PATH
amrita lane cancel <LANE_ID> --db PATH

amrita connectors status --db PATH                         # live probe-backed states (ADR-0022), never fake green
amrita github import --project <ID_OR_SLUG> --repo <owner/name> [--state open|all] [--limit N] --db PATH
```

`amrita lane start` records a lane mandate and (unless `--dry-run`) runs it through the kernel's lane
runner. **Real Claude Code execution is opt-in and off by default** (ADR-0015): without
`AMRITA_LANES_ALLOW_REAL_EXECUTION=1`, a non-dry start (and `--real`) ends safely as `aborted` with a
clear message. `--dry-run` records the `lane.spawned`/`lane.mandate` events and returns the lane id
without running anything. `amrita lane list` shows each lane's status/kind/goal; `lane get` shows one
lane with its report exit; `lane cancel` stops a running lane (it reports `exit: 'cancelled'`).
`amrita health` shows whether lane real-execution is enabled. No lane command reads or prints a secret
value, and no secret (including `ANTHROPIC_API_KEY`) is ever forwarded into a lane.

`amrita doctor` renders the kernel's `doctor` report (PLAN §5.4): grouped `◆` sections (store,
providers, lanes, channels, connectors, auth) with warn-vs-fail scoping — unconfigured is a
*warning* ("needs setup"), an account bound to a missing env var is a *failure* — and a numbered
"run this exact command" footer. Env checks are presence-only; no value is ever read or printed.

`amrita connectors status` prints each code-registered connector's live state (ADR-0022):
`connected` only after a real probe, `configured_but_failing` when the API rejects the token,
`needs_setup` with missing env NAMES and the exact export command. `amrita github import` is the
one-way issues → tasks import: idempotent (`skipped` counts re-runs), provenance-tagged
(`github:owner/repo#N`), PRs excluded, and the token is read from `GITHUB_TOKEN` at call time —
errors name the env var, never a value.

`amrita chat` runs one turn through the kernel: it records your message, calls the provider boundary
(default **`mock`**, deterministic), and prints the assistant reply plus a `(provider · model · in/out
tok)` metadata line (or the full result with `--json`). With no `--conversation`, it uses the project's
default conversation (WO#2.2).

**Real providers (ADR-0012):** `--provider anthropic` or `--provider openai` runs the real adapter —
*if* you've connected an account for that provider and bound its `secret_ref` to an env var that is
set in your environment:

```bash
amrita account connect --provider anthropic --label work --db PATH      # → ACCOUNT_ID
amrita account bind-secret ACCOUNT_ID ANTHROPIC_API_KEY --db PATH        # binds a NAME, not a value
export ANTHROPIC_API_KEY=...                                             # the value lives only here
amrita chat "hello" --provider anthropic --model claude-sonnet-4-5 --db PATH
```

If no account is configured (or its env var is missing), `chat` fails with a safe structured error and
a non-zero exit — never a secret value. `amrita provider list` shows each provider's availability,
configured-account count, and whether its env var is present (a boolean — never the value).

## Project & conversation resolution

- `--project` accepts a **slug or id** (slug is tried first, then id).
- Every write needs a `(projectId, conversationId)` envelope. When a command supplies no
  `--conversation`, the CLI uses that project's **`(default)` conversation** (find-or-create by a
  sentinel title, so it is reused). Commands with no project context (`account *`, user-scope
  `memory put`) fall back to a **`system`** project + its default conversation. `message user` derives
  the project from the conversation id.

## Secret handling

`account bind-secret <ACCOUNT_ID> <ENV_NAME>` stores only the **env-var name** (e.g.
`ANTHROPIC_API_KEY`) via the daemon's secure binding — never a secret value, and never through an
event. The CLI prints the env-name (a reference, not a secret) and `account status` shows
`missing_secret_ref | secret_ref_bound | degraded | healthy`. No command reads or prints a secret
value. `account connect --label` persists a display label (ADR-0010); the actual key lives only in
your environment.

## Not implemented yet

Streaming responses, tool calling, Telegram, web UI, lanes, and installer/update are future work.
`amrita chat` runs the full async turn against the `mock` provider or a configured `anthropic`/`openai`
account (ADR-0012). Real adapters are never exercised against the network in tests.
