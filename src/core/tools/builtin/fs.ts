import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises';
import { resolve, dirname, isAbsolute } from 'node:path';
import type { ToolContext } from '../../../shared/types.ts';
import { registerTool } from '../registry.ts';

/**
 * Path policy: project-bound sessions resolve relative paths against the
 * project workingDir and may not escape it. Absolute paths are allowed only
 * for main-Amrita sessions (server owner context).
 */
function resolvePath(raw: string, ctx: ToolContext): string {
  if (ctx.workingDir) {
    const full = isAbsolute(raw) ? raw : resolve(ctx.workingDir, raw);
    if (!full.startsWith(resolve(ctx.workingDir))) {
      throw new Error(`Path escapes the project working directory: ${raw}`);
    }
    return full;
  }
  if (ctx.projectSlug) throw new Error('This project has no working directory configured.');
  return resolve(raw);
}

registerTool({
  name: 'file_read',
  toolset: 'files',
  description:
    'Read a text file. In a project, paths are relative to the project working directory.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
      maxBytes: { type: 'number', description: 'Optional byte cap (default 100000)' },
    },
    required: ['path'],
  },
  handler: async (args, ctx) => {
    const full = resolvePath(String(args.path), ctx);
    const buf = await readFile(full);
    const cap = Number(args.maxBytes ?? 100_000);
    return buf.subarray(0, cap).toString('utf8');
  },
});

registerTool({
  name: 'file_write',
  toolset: 'files',
  description: 'Write/overwrite a text file (creates parent directories).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
  },
  handler: async (args, ctx) => {
    const full = resolvePath(String(args.path), ctx);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, String(args.content), 'utf8');
    return `Wrote ${String(args.content).length} chars to ${full}`;
  },
});

registerTool({
  name: 'list_dir',
  toolset: 'files',
  description: 'List directory entries with type and size.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Directory path (default ".")' } },
  },
  handler: async (args, ctx) => {
    const full = resolvePath(String(args.path ?? '.'), ctx);
    const entries = await readdir(full, { withFileTypes: true });
    const lines = await Promise.all(
      entries.slice(0, 200).map(async (e) => {
        if (e.isDirectory()) return `${e.name}/`;
        const s = await stat(resolve(full, e.name)).catch(() => null);
        return `${e.name}  (${s ? s.size : '?'} bytes)`;
      }),
    );
    return lines.join('\n') || '(empty)';
  },
});
