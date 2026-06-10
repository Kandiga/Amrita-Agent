import { spawn } from 'node:child_process';
import { registerTool } from '../registry.ts';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 40_000;

registerTool({
  name: 'shell_run',
  toolset: 'shell',
  description:
    'Run a shell command on the server. In a project, the cwd is the project working directory. Long-running daemons are not allowed — commands are killed after the timeout.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Bash command to run' },
      timeoutSeconds: { type: 'number', description: 'Timeout (default 120, max 600)' },
    },
    required: ['command'],
  },
  handler: (args, ctx) =>
    new Promise((resolvePromise) => {
      const timeout = Math.min(Number(args.timeoutSeconds ?? 120), 600) * 1000 || DEFAULT_TIMEOUT_MS;
      const child = spawn('bash', ['-lc', String(args.command)], {
        cwd: ctx.workingDir ?? process.cwd(),
        env: { ...process.env, AMRITA: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let killed = false;
      const cap = (chunk: Buffer) => {
        if (out.length < MAX_OUTPUT) out += chunk.toString('utf8');
      };
      child.stdout.on('data', cap);
      child.stderr.on('data', cap);
      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGKILL');
      }, timeout);
      const onAbort = () => {
        killed = true;
        child.kill('SIGKILL');
      };
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      child.on('close', (code) => {
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        const status = killed ? '(killed: timeout/abort)' : `(exit ${code})`;
        resolvePromise(`${status}\n${out.slice(0, MAX_OUTPUT) || '(no output)'}`);
      });
    }),
});
