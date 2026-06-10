import { registerTool } from '../core/tools/registry.ts';
import { loadConfig } from '../shared/config.ts';
import { audit } from '../core/store/audit.ts';
import { id, truncate } from '../shared/util.ts';

/**
 * Open Design connector — drives the local Open Design daemon over its HTTP
 * API. Open Design is an optional tool, never Amrita's shell: results render
 * in a preview lane and land back in the conversation.
 */

function baseUrl(): string {
  return loadConfig().connectors.openDesign.baseUrl.replace(/\/$/, '');
}

async function od(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    signal: init?.signal ?? AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Open Design ${path} → HTTP ${res.status}`);
  return res.json();
}

registerTool({
  name: 'open_design_status',
  toolset: 'connectors',
  description: 'Check whether the local Open Design daemon is running and list its projects.',
  parameters: { type: 'object', properties: {} },
  handler: async () => {
    if (!loadConfig().connectors.openDesign.enabled) {
      return 'The Open Design connector is disabled. Enable it in Settings → Connectors.';
    }
    try {
      await od('/api/health');
    } catch {
      return `Open Design is not reachable at ${baseUrl()}. Start it (docker compose up -d in the open-design folder) or fix the URL in settings.`;
    }
    try {
      const projects = (await od('/api/projects')) as { id?: string; name?: string }[] | { projects?: { id?: string; name?: string }[] };
      const list = Array.isArray(projects) ? projects : (projects.projects ?? []);
      return `Open Design is up.\nProjects:\n${list.map((p) => `- ${p.name ?? '?'} (${p.id ?? '?'})`).join('\n') || '(none)'}`;
    } catch {
      return 'Open Design is up (health OK), but the projects API was not readable.';
    }
  },
});

registerTool({
  name: 'open_design_run',
  toolset: 'connectors',
  description:
    'Start a design/prototype generation run in Open Design and stream progress to a preview lane. Use for visual design work the user wants to see.',
  parameters: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: 'Open Design project id (from open_design_status)' },
      brief: { type: 'string', description: 'What to design/generate' },
    },
    required: ['projectId', 'brief'],
  },
  handler: async (args, ctx) => {
    if (!loadConfig().connectors.openDesign.enabled) {
      return 'The Open Design connector is disabled.';
    }
    const laneId = id('lane');
    ctx.emitLane({
      kind: 'open',
      laneId,
      lane: 'preview',
      title: 'Open Design',
      url: `${baseUrl()}/`,
    });
    audit('connector-launch', { connector: 'open-design', projectId: String(args.projectId) }, ctx);
    try {
      const run = (await od('/api/runs', {
        method: 'POST',
        body: JSON.stringify({ projectId: String(args.projectId), message: String(args.brief) }),
      })) as { id?: string; runId?: string };
      const runId = run.id ?? run.runId ?? 'unknown';
      ctx.emitLane({ kind: 'status', laneId, status: `run ${runId} started` });

      // Poll for completion (v1 — webhooks are an upstream wish).
      const deadline = Date.now() + 10 * 60 * 1000;
      while (Date.now() < deadline && !ctx.signal.aborted) {
        await new Promise((r) => setTimeout(r, 4000));
        try {
          const status = (await od(`/api/runs/${runId}`)) as { status?: string; output?: string };
          ctx.emitLane({ kind: 'status', laneId, status: status.status ?? 'running' });
          if (status.status && ['done', 'completed', 'failed', 'error', 'cancelled'].includes(status.status)) {
            ctx.emitLane({ kind: 'close', laneId });
            return `Open Design run ${runId} finished: ${status.status}.\n${truncate(status.output ?? '', 2000)}\nPreview: ${baseUrl()}/`;
          }
        } catch {
          // transient poll error — keep waiting
        }
      }
      ctx.emitLane({ kind: 'close', laneId });
      return `Open Design run ${runId} is still in progress — check the preview at ${baseUrl()}/`;
    } catch (err) {
      ctx.emitLane({ kind: 'close', laneId });
      return `Open Design run failed: ${err instanceof Error ? err.message : err}`;
    }
  },
});
