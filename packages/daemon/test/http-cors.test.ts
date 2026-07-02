import { describe, expect, it } from 'vitest';
import { corsAllowedOrigin } from '../src/http.ts';

describe('amritad CORS policy (Phase 7)', () => {
  it('default: local pages allowed, remote denied', () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(corsAllowedOrigin('http://localhost:3002', env)).toBe('http://localhost:3002');
    expect(corsAllowedOrigin('http://127.0.0.1:3002', env)).toBe('http://127.0.0.1:3002');
    expect(corsAllowedOrigin('https://amrita-agent.tech', env)).toBeNull();
    expect(corsAllowedOrigin('http://evil.example', env)).toBeNull();
  });
  it('explicit allowlist replaces the default entirely (exact match)', () => {
    const env = {
      AMRITA_ALLOWED_ORIGINS: 'https://amrita-agent.tech, http://localhost:3002',
    } as NodeJS.ProcessEnv;
    expect(corsAllowedOrigin('https://amrita-agent.tech', env)).toBe('https://amrita-agent.tech');
    expect(corsAllowedOrigin('http://localhost:3002', env)).toBe('http://localhost:3002');
    expect(corsAllowedOrigin('http://127.0.0.1:3002', env)).toBeNull(); // not listed → denied
  });
  it('no Origin header (curl/CLI) → no CORS reflection, unaffected', () => {
    expect(corsAllowedOrigin(undefined, {} as NodeJS.ProcessEnv)).toBeNull();
  });
});
