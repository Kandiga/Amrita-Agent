import { registerTool } from '../registry.ts';

registerTool({
  name: 'web_fetch',
  toolset: 'web',
  description: 'Fetch a URL and return its text content (HTML is crudely stripped to text).',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'http(s) URL' },
      maxChars: { type: 'number', description: 'Cap on returned chars (default 20000)' },
    },
    required: ['url'],
  },
  handler: async (args, ctx) => {
    const url = String(args.url);
    if (!/^https?:\/\//.test(url)) throw new Error('Only http(s) URLs are allowed');
    const res = await fetch(url, {
      signal: ctx.signal,
      headers: { 'user-agent': 'amrita-agent/0.1 (+https://github.com/amrita-agent)' },
      redirect: 'follow',
    });
    const type = res.headers.get('content-type') ?? '';
    let text = await res.text();
    if (type.includes('html')) {
      text = text
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s{3,}/g, '\n');
    }
    return `HTTP ${res.status} ${type}\n\n${text.slice(0, Number(args.maxChars ?? 20_000))}`;
  },
});
