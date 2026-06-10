# Spec: the `amrita` CLI

`@amrita/cli` is a local command-line client for the amritad kernel. It speaks the JSON-RPC layer
**in process** (it opens a kernel on `--db` and dispatches directly — no subprocess), so it is fast
and deterministic. See [ADR-0009](../adr/0009-amritad-kernel-and-rpc.md) for the RPC boundary.

**No provider calls, chat turn loop, or tool/lane execution run here** — this CLI operates the store
and config surfaces only.

## Invocation

```bash
pnpm amrita -- <command> [args] --db <PATH> [--json]
# or directly:
node packages/cli/src/bin/amrita.ts health --db ~/.amrita/amrita.db
```

`--db <PATH>` is **required** (use `:memory:` for a throwaway DB). The DB is opened and migrated on
each invocation and closed on exit; state persists when `--db` is a file path.

- **Exit codes:** `0` success · `1` RPC failure · `2` usage/validation error.
- **Output:** concise human text by default; `--json` emits the raw JSON result (or `{error:{…}}`).
- Errors never print a stack trace or a secret value.

## Commands

```bash
amrita health --db PATH

amrita project ensure <slug> [--name NAME] --db PATH      # create-or-get
amrita project list --db PATH

amrita conversation create --project <ID_OR_SLUG> [--title T] [--parent ID] --db PATH
amrita conversation tree <CONVERSATION_ID> --db PATH

amrita message user <CONVERSATION_ID> <TEXT> --db PATH

amrita task create --project <ID_OR_SLUG> --title TITLE [--conversation ID] --db PATH
amrita task list --project <ID_OR_SLUG> --db PATH
amrita task complete <TASK_ID> --db PATH

amrita decision record --project <ID_OR_SLUG> --text TEXT [--conversation ID] --db PATH

amrita memory put --scope user|project --content TEXT [--project ID_OR_SLUG] --db PATH
amrita memory search <QUERY> [--scope user|project] [--project ID_OR_SLUG] --db PATH

amrita account connect --provider PROVIDER [--label LABEL] [--auth-mode MODE] --db PATH
amrita account bind-secret <ACCOUNT_ID> <ENV_NAME> --db PATH
amrita account status <ACCOUNT_ID> --db PATH

amrita chat <TEXT> [--project ID_OR_SLUG] [--conversation ID] [--provider mock] [--model MODEL] --db PATH
amrita provider list --db PATH

amrita lane list [--project ID_OR_SLUG] [--conversation ID] [--status STATUS] --db PATH
amrita lane start --goal TEXT [--project ID_OR_SLUG] [--conversation ID] [--kind claude-code] [--dry-run] --db PATH
```

`amrita lane start` records a lane mandate and (unless `--dry-run`) runs it through the kernel's lane
runner. The default runner **refuses real Claude Code execution** (ADR-0014), so a non-dry start ends
as `aborted` until real execution is explicitly enabled in a future WO; `--dry-run` records the
`lane.spawned`/`lane.mandate` events and returns the lane id without running anything. `amrita lane
list` shows each lane's status, kind, and goal. No lane command reads or prints a secret value, and no
secret (including `ANTHROPIC_API_KEY`) is ever forwarded into a lane.

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
