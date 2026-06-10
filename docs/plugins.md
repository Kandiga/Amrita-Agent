# Tools, connectors, and extending Amrita

## The capability model

| Type | What it is | Where |
|---|---|---|
| **Tool** | A function the model can call, grouped into **toolsets** (permission groups) | `src/core/tools/builtin/` |
| **Connector** | A tool that drives an external system and can open a **lane** | `src/connectors/` |
| **Plugin** | Logic Amrita itself uses (e.g. the prompt engineer) | `src/plugins/` |

## Toolsets = permissions

Every tool declares a `toolset` (`files`, `shell`, `web`, `memory`, `projects`, `scheduling`, `connectors`). Contexts strip toolsets:

- **Cron jobs** always run without `scheduling` and `connectors` (an unattended job can't schedule more jobs or launch big agents) — adopted from Hermes.
- `config.json → toolsets.disabled` disables globally.
- Project file tools are jailed to the project's working directory.

Every execution lands in the append-only `audit` table.

## Writing a tool

```ts
import { registerTool } from '../core/tools/registry.ts';

registerTool({
  name: 'my_tool',
  toolset: 'web',
  description: 'Written for the model: what it does, when to use it, when NOT to.',
  parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  handler: async (args, ctx) => {
    // ctx: projectSlug, sessionId, channel, chatId, workingDir, emitLane, signal
    return 'plain text result for the model';
  },
});
```

Import it from `src/core/tools/index.ts` and it exists everywhere — CLI, web, Telegram, cron.

## Writing a connector

A connector is a tool that talks to an external system and narrates progress through a lane:

```ts
const laneId = id('lane');
ctx.emitLane({ kind: 'open', laneId, lane: 'console', title: 'My Tool' });
ctx.emitLane({ kind: 'output', laneId, text: 'doing things…\n' });
ctx.emitLane({ kind: 'close', laneId });
```

The web UI renders `console` lanes as a live terminal panel and `preview` lanes as an iframe; Telegram degrades to link + status messages. Study `src/connectors/claude-code.ts` (process spawn + stream-json parsing) and `src/connectors/open-design.ts` (HTTP API + polling).

Connector rules:
1. **Degrade honestly.** Not installed / not running / not configured → a clear sentence, never a fake success.
2. **Own no credentials.** CLI connectors inherit the CLI's login; HTTP connectors hit localhost services.
3. **Audit the launch** (`audit('connector-launch', …)`).

## The prompt-engineer plugin

`src/plugins/prompt-engineer.ts` turns "fix the export bug" into a structured downstream brief (role/context/task/constraints/success criteria/output contract — Anthropic's published prompt-engineering guidance, XML-tagged). The Claude Code connector calls it automatically; disable with `promptEngineer.enabled = false`.

## MCP

MCP servers are the natural next extension point: an MCP client that registers each server's tools as `mcp.<server>.<tool>` into the same registry, with config under `config.json → mcpServers` (`command/args/env` or `url/headers`). The registry/toolset/audit machinery is already shaped for it.
