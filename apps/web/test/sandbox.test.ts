import { describe, expect, it } from 'vitest';
import {
  MAX_PREVIEW_BYTES,
  PREVIEW_SANDBOX,
  artifactPreviewPath,
  assertSafeSandbox,
  previewByteLength,
} from '../src/sandbox.ts';

/**
 * Stage-B sandbox security contract, hardened by ADR-0057 finding 3: previews
 * load from the daemon's self-CSP'd `/artifact` route in an opaque-origin
 * sandbox — never srcdoc (which would inherit the app CSP).
 */
describe('Stage-B sandbox harness (security contract)', () => {
  it('the sandbox attribute never grants a real origin or top navigation', () => {
    expect(PREVIEW_SANDBOX.split(/\s+/)).not.toContain('allow-same-origin');
    expect(() => assertSafeSandbox('allow-scripts allow-same-origin')).toThrow(/allow-same-origin/);
    expect(() => assertSafeSandbox('allow-scripts allow-top-navigation')).toThrow(/top navigation/);
    expect(() => assertSafeSandbox('allow-scripts')).not.toThrow();
  });

  it('builds a same-origin ticket path and never embeds a bearer/secret in it', () => {
    const path = artifactPreviewPath('id123', 'tk-abc_-');
    expect(path).toBe('/artifact/id123/t/tk-abc_-');
    expect(path).not.toMatch(/Bearer|authorization|token=|amrita.*token/i);
  });

  it('encodes id/ticket defensively (no path escape from a URL segment)', () => {
    const path = artifactPreviewPath('a/b', 'c/d');
    expect(path).toBe('/artifact/a%2Fb/t/c%2Fd');
  });

  it('exposes the shared byte budget so the caller can spill oversize builds', () => {
    expect(previewByteLength('hello')).toBe(5);
    expect(previewByteLength('x'.repeat(MAX_PREVIEW_BYTES))).toBe(MAX_PREVIEW_BYTES);
  });
});
