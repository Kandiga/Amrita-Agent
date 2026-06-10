import { spawn } from 'node:child_process';
import { registerTool } from '../core/tools/registry.ts';
import { loadConfig } from '../shared/config.ts';
import { getProject } from '../projects/manager.ts';
import { generateBrief } from '../plugins/prompt-engineer.ts';
import { audit } from '../core/store/audit.ts';
import { id, truncate } from '../shared/util.ts';

/**
 * Claude Code connector — CLI passthrough over the officially documented
 * headless mode (`claude -p --output-format stream-json`). Auth belongs to
 * the locally logged-in Claude Code (user subscription via the Agent SDK
 * credit, or ANTHROPIC_API_KEY). Amrita never reads or stores its tokens.
 */

interface StreamLine {
  type: string;
  subtype?: string;
  result?: string;
  total_cost_usd?: number;
  message?: { content?: ({ type: string; text?: string; name?: string } | Record<string, unknown>)[] };
}

registerTool({
  name: 'claude_code_run',
  toolset: 'connectors',
  description:
    'Delegate a coding task to Claude Code in the project working directory. Use for real implementation work (features, fixes, refactors). Provide the user intent; a precise brief is generated automatically. Long-running: prefer one well-scoped task per call.',
  parameters: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'What Claude Code should accomplish' },
      cwd: { type: 'string', description: 'Override working directory (optional)' },
    },
    required: ['task'],
  },
  handler: async (args, ctx) => {
    const config = loadConfig();
    if (!config.connectors.claudeCode.enabled) {
      return 'The Claude Code connector is disabled. Enable it in Settings → Connectors.';
    }
    const project = ctx.projectSlug ? getProject(ctx.projectSlug) : null;
    const cwd = (args.cwd ? String(args.cwd) : null) ?? ctx.workingDir;
    if (!cwd) {
      return 'No working directory: link this project to a directory first (project settings), or pass cwd.';
    }

    const brief = await generateBrief(String(args.task), project, 'claude-code');
    const laneId = id('lane');
    ctx.emitLane({ kind: 'open', laneId, lane: 'console', title: 'Claude Code' });
    ctx.emitLane({ kind: 'output', laneId, text: `📋 Brief:\n${brief}\n\n` });
    audit('connector-launch', { connector: 'claude-code', cwd }, ctx);

    const permissionMode =
      config.connectors.claudeCode.autonomy === 'auto' ? 'bypassPermissions' : 'acceptEdits';

    return await new Promise<string>((resolvePromise) => {
      const child = spawn(
        'claude',
        ['-p', brief, '--output-format', 'stream-json', '--verbose', '--permission-mode', permissionMode],
        { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } },
      );

      let buffer = '';
      let finalResult = '';
      let activity: string[] = [];

      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let event: StreamLine;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          if (event.type === 'assistant') {
            for (const block of event.message?.content ?? []) {
              if (block.type === 'text' && typeof block.text === 'string') {
                ctx.emitLane({ kind: 'output', laneId, text: block.text + '\n' });
              } else if (block.type === 'tool_use' && typeof block.name === 'string') {
                ctx.emitLane({ kind: 'status', laneId, status: `⚙ ${block.name}` });
                activity.push(String(block.name));
              }
            }
          } else if (event.type === 'result') {
            finalResult = event.result ?? '';
          }
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        ctx.emitLane({ kind: 'output', laneId, text: chunk.toString('utf8') });
      });

      const onAbort = () => child.kill('SIGTERM');
      ctx.signal.addEventListener('abort', onAbort, { once: true });

      child.on('error', (err) => {
        ctx.emitLane({ kind: 'close', laneId });
        resolvePromise(
          `Claude Code is not available on this server (${err.message}). Install it or disable the connector.`,
        );
      });
      child.on('close', (code) => {
        ctx.signal.removeEventListener('abort', onAbort);
        ctx.emitLane({ kind: 'close', laneId });
        const toolSummary = activity.length
          ? `Tools used: ${[...new Set(activity)].join(', ')}.`
          : '';
        if (code === 0 && finalResult) {
          resolvePromise(`Claude Code finished.\n${toolSummary}\n\nResult:\n${truncate(finalResult, 6000)}`);
        } else {
          resolvePromise(
            `Claude Code exited with code ${code}. ${toolSummary}\n${truncate(finalResult, 2000) || 'No result payload — check that claude is logged in (run `claude` once on the server) and that the Agent SDK credit is not exhausted.'}`,
          );
        }
      });
    });
  },
});
