import { registerTool } from '../registry.ts';
import {
  appendDecision,
  appendUserMemory,
  readVaultFile,
  writeVaultFile,
} from '../../memory/vault.ts';
import { searchMessages } from '../../store/sessions.ts';
import { createProject, listProjects } from '../../../projects/manager.ts';

registerTool({
  name: 'remember_about_user',
  toolset: 'memory',
  description:
    'Save a durable fact about the user (preference, role, recurring need) to global memory. Use sparingly, for things worth knowing in every future conversation.',
  parameters: {
    type: 'object',
    properties: { fact: { type: 'string' } },
    required: ['fact'],
  },
  handler: async (args) => {
    appendUserMemory(String(args.fact));
    return 'Saved to user memory.';
  },
});

registerTool({
  name: 'vault_append_decision',
  toolset: 'memory',
  description: 'Record a project decision in the append-only decision log (project sessions only).',
  parameters: {
    type: 'object',
    properties: { decision: { type: 'string', description: 'The decision and its why' } },
    required: ['decision'],
  },
  handler: async (args, ctx) => {
    if (!ctx.projectSlug) return 'Not in a project context — nothing recorded.';
    appendDecision(ctx.projectSlug, String(args.decision));
    return 'Decision recorded in DECISIONS.md.';
  },
});

registerTool({
  name: 'vault_update',
  toolset: 'memory',
  description:
    'Read or update a project vault file: BRIEF.md, CONTEXT.md or TASKS.md. Provide content to overwrite; omit it to read. Keep CONTEXT.md small — it is loaded into every session.',
  parameters: {
    type: 'object',
    properties: {
      file: { type: 'string', enum: ['BRIEF.md', 'CONTEXT.md', 'TASKS.md'] },
      content: { type: 'string' },
    },
    required: ['file'],
  },
  handler: async (args, ctx) => {
    if (!ctx.projectSlug) return 'Not in a project context.';
    const file = String(args.file) as 'BRIEF.md' | 'CONTEXT.md' | 'TASKS.md';
    if (args.content === undefined) return readVaultFile(ctx.projectSlug, file) || '(empty)';
    writeVaultFile(ctx.projectSlug, file, String(args.content));
    return `Updated ${file}.`;
  },
});

registerTool({
  name: 'search_history',
  toolset: 'memory',
  description:
    'Full-text search across past conversations (scoped to the current project when in one).',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
  handler: async (args, ctx) => {
    const hits = searchMessages(String(args.query), ctx.projectSlug ?? undefined);
    if (!hits.length) return 'No matches.';
    return hits.map((h) => `[${h.sessionId}] ${h.snippet}`).join('\n');
  },
});

registerTool({
  name: 'project_create',
  toolset: 'projects',
  description:
    'Create a new Amrita project (scaffolds its memory vault). Optionally link a working directory on the server.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      workingDir: { type: 'string', description: 'Absolute path to the project code (optional)' },
    },
    required: ['name'],
  },
  handler: async (args) => {
    const project = createProject(String(args.name), args.workingDir ? String(args.workingDir) : null);
    return `Created project "${project.name}" (slug: ${project.slug}). The user can switch to it from the sidebar or /projects.`;
  },
});

registerTool({
  name: 'project_list',
  toolset: 'projects',
  description: 'List existing Amrita projects.',
  parameters: { type: 'object', properties: {} },
  handler: async () => {
    const projects = listProjects();
    if (!projects.length) return 'No projects yet.';
    return projects
      .map((p) => `- ${p.name} (${p.slug})${p.workingDir ? ` — ${p.workingDir}` : ''}`)
      .join('\n');
  },
});
