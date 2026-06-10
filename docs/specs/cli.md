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
```

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

Chat with a model, streaming responses, provider runtime, Telegram, web UI, lanes/tools, and
installer/update are future work — the CLI today is for operating projects, memory, tasks, decisions,
and provider config locally.
