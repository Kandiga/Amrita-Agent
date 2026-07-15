import { describe, expect, it } from 'vitest';
import { extractAgentArtifacts, extractStreamingArtifact } from '../src/agent-canvas.ts';
import type { ChatMessage } from '../src/lib.ts';

const agent = (id: string, text: string): ChatMessage => ({ id, role: 'agent', text });
const user = (id: string, text: string): ChatMessage => ({ id, role: 'user', text });

describe('agent HTML lands on the canvas (CANVAS-1)', () => {
  it('extracts a fenced ```html block into an openable artifact', () => {
    const msgs = [
      user('u1', 'build me a game'),
      agent(
        'a1',
        'Here you go:\n```html\n<!doctype html><title>Gravity</title><canvas></canvas><script>1</script>\n```\nEnjoy.',
      ),
    ];
    const arts = extractAgentArtifacts(msgs, 'p1');
    expect(arts).toHaveLength(1);
    expect(arts[0]?.kind).toBe('html-preview');
    expect(arts[0]?.title).toBe('Gravity');
    expect(arts[0]?.html).toContain('<canvas>');
    expect(arts[0]?.html).toContain('<script>'); // interactive game scripts survive
    expect(arts[0]?.id).toBe('agent-html:a1:0');
    expect(arts[0]?.status).toBe('approved');
  });

  it('treats a whole-message HTML document as a build even without a fence', () => {
    const arts = extractAgentArtifacts(
      [agent('a1', '<!DOCTYPE html><html><h1>Hi</h1></html>')],
      'p1',
    );
    expect(arts).toHaveLength(1);
    expect(arts[0]?.title).toBe('Hi');
  });

  it('ignores plain prose and user turns', () => {
    const msgs = [
      user('u1', '<html>from a user, ignored</html>'),
      agent('a1', 'just talking, no html here'),
    ];
    expect(extractAgentArtifacts(msgs, 'p1')).toHaveLength(0);
  });

  it('never renders a half-written streaming draft', () => {
    const draft: ChatMessage = {
      id: 'd',
      role: 'agent',
      text: '```html\n<!doctype html><ti',
      pending: true,
    };
    expect(extractAgentArtifacts([draft], 'p1')).toHaveLength(0);
  });

  it('a changed build produces a NEW artifact id (so the canvas re-opens on it)', () => {
    const v1 = extractAgentArtifacts([agent('a1', '```html\n<title>v1</title>\n```')], 'p1');
    const v2 = extractAgentArtifacts([agent('a2', '```html\n<title>v2</title>\n```')], 'p1');
    expect(v1[0]?.id).not.toBe(v2[0]?.id);
    expect(v2[0]?.title).toBe('v2');
  });

  it('extracts multiple html blocks from one message with distinct ids', () => {
    const arts = extractAgentArtifacts(
      [agent('a1', '```html\n<h1>one</h1>\n```\nand\n```html\n<h1>two</h1>\n```')],
      'p1',
    );
    expect(arts.map((a) => a.id)).toEqual(['agent-html:a1:0', 'agent-html:a1:1']);
  });
});

describe('live-build streaming (Live Canvas Phase 2)', () => {
  it('renders the partial HTML of an OPEN html block as a building card', () => {
    const draft =
      "sure!\n```html\n<!doctype html><title>Pong</title><h1>Pong</h1><div class='board'>";
    const s = extractStreamingArtifact(draft);
    expect(s?.building).toBe(true);
    expect(s?.id).toBe('agent-html:building');
    expect(s?.title).toBe('Pong');
    expect(s?.html).toContain('<h1>Pong</h1>');
  });

  it('strips scripts while streaming so half-written JS cannot break the render', () => {
    const draft = '```html\n<h1>Hi</h1><script>const x = fn(';
    const s = extractStreamingArtifact(draft);
    expect(s?.html).toContain('<h1>Hi</h1>');
    expect(s?.html).not.toContain('<script');
    expect(s?.html).not.toContain('fn(');
  });

  it('stops streaming once the block CLOSES — the committed message takes over', () => {
    const draft = '```html\n<h1>done</h1>\n```\nthere you go';
    expect(extractStreamingArtifact(draft)).toBeNull();
  });

  it('returns null before any html block, and for empty/undefined drafts', () => {
    expect(extractStreamingArtifact('just talking still')).toBeNull();
    expect(extractStreamingArtifact('')).toBeNull();
    expect(extractStreamingArtifact(null)).toBeNull();
    expect(extractStreamingArtifact('```html\n   ')).toBeNull(); // nothing meaningful yet
  });
});
