import { registerTool } from '../registry.ts';
import { createJob, deleteJob, listJobs } from '../../../scheduler/scheduler.ts';
import { parseCron } from '../../../scheduler/cron.ts';

registerTool({
  name: 'schedule_create',
  toolset: 'scheduling',
  description:
    'Schedule a recurring task in natural language + cron. The prompt runs unattended on the schedule; results can be delivered to the chat that created it.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Short job name' },
      schedule: { type: 'string', description: '5-field cron, e.g. "0 9 * * 1" for Mondays 09:00' },
      prompt: { type: 'string', description: 'What Amrita should do on each run' },
      deliverHere: { type: 'boolean', description: 'Send results to this chat (default true)' },
    },
    required: ['name', 'schedule', 'prompt'],
  },
  handler: async (args, ctx) => {
    parseCron(String(args.schedule)); // validate, throws on bad cron
    const deliver = args.deliverHere !== false && ctx.chatId !== null;
    const job = createJob({
      name: String(args.name),
      schedule: String(args.schedule),
      prompt: String(args.prompt),
      projectSlug: ctx.projectSlug,
      delivery: deliver ? { channel: ctx.channel, chatId: ctx.chatId! } : null,
      enabled: true,
    });
    return `Scheduled "${job.name}" (${job.schedule}), next run ${job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : 'unknown'}. id: ${job.id}`;
  },
});

registerTool({
  name: 'schedule_list',
  toolset: 'scheduling',
  description: 'List scheduled jobs.',
  parameters: { type: 'object', properties: {} },
  handler: async () => {
    const jobs = listJobs();
    if (!jobs.length) return 'No scheduled jobs.';
    return jobs
      .map(
        (j) =>
          `- ${j.name} [${j.id}] ${j.schedule} ${j.enabled ? '' : '(disabled)'} next: ${j.nextRunAt ? new Date(j.nextRunAt).toLocaleString() : '-'}`,
      )
      .join('\n');
  },
});

registerTool({
  name: 'schedule_delete',
  toolset: 'scheduling',
  description: 'Delete a scheduled job by id.',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
  handler: async (args) => {
    deleteJob(String(args.id));
    return 'Deleted.';
  },
});
