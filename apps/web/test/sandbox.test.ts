import { describe, expect, it } from 'vitest';
import {
  type HtmlPreviewSpec,
  MAX_PREVIEW_BYTES,
  PREVIEW_CSP,
  PREVIEW_SANDBOX,
  assertSafeSandbox,
  buildSandboxedPreview,
} from '../src/sandbox.ts';

function spec(html: string): HtmlPreviewSpec {
  return { kind: 'html-preview', id: 'pv1', projectId: 'P1', title: 'test', html };
}

describe('Stage-B sandbox harness (security contract)', () => {
  it('the sandbox attribute never grants a real origin or top navigation', () => {
    expect(PREVIEW_SANDBOX.split(/\s+/)).not.toContain('allow-same-origin');
    expect(() => assertSafeSandbox('allow-scripts allow-same-origin')).toThrow(/allow-same-origin/);
    expect(() => assertSafeSandbox('allow-scripts allow-top-navigation')).toThrow(/top navigation/);
    expect(() => assertSafeSandbox('allow-scripts')).not.toThrow();
  });

  it('bakes the zero-network CSP into every preview document', () => {
    const { srcDoc, sandbox } = buildSandboxedPreview(spec('<h1>hello</h1>'));
    expect(sandbox).toBe('allow-scripts');
    expect(srcDoc).toContain(`content="${PREVIEW_CSP}"`);
    expect(PREVIEW_CSP).toContain("default-src 'none'");
    expect(PREVIEW_CSP).toContain("frame-src 'none'");
    expect(srcDoc).toContain('<body><h1>hello</h1></body>');
  });

  it('enforces the inline size budget — oversize must spill, never truncate', () => {
    const big = 'x'.repeat(MAX_PREVIEW_BYTES + 1);
    expect(() => buildSandboxedPreview(spec(big))).toThrow(/spill it to an artifact file/);
  });

  it('the harness adds nothing token-shaped — output is wrapper + input only', () => {
    const { srcDoc } = buildSandboxedPreview(spec('<p>safe</p>'));
    // the wrapper itself must never embed auth material or storage access
    expect(srcDoc).not.toMatch(/Bearer|authorization|localStorage|amrita.*token/i);
  });
});
