import { describe, expect, it } from 'vitest';
import { type CommandProber, getClaudeCodeStatus, getCodexStatus } from '../src/runtimes.ts';

/**
 * Community onboarding P2 (findings 5/7): the observed auth/billing mode comes
 * from the CLI's OWN status output, never from exit code; login hints are the
 * current official commands.
 */

const proberFor =
  (cmd: string, authStdout: string): CommandProber =>
  async (c, args) => {
    if (args.includes('--version')) return { kind: 'ok', stdout: `${cmd} 2.0.0` };
    // auth/login status
    return authStdout ? { kind: 'ok', stdout: authStdout } : { kind: 'failed', stdout: '' };
  };

describe('observed auth mode (P2)', () => {
  it('claude subscription login → authMode subscription', async () => {
    const st = await getClaudeCodeStatus({
      realExecution: false,
      prober: proberFor(
        'claude',
        JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }),
      ),
    });
    expect(st.state).toBe('ready');
    expect(st.authMode).toBe('subscription');
  });

  it('claude driven by an API key → authMode api-key (never mislabelled subscription)', async () => {
    const st = await getClaudeCodeStatus({
      realExecution: false,
      prober: proberFor('claude', JSON.stringify({ loggedIn: true, authMethod: 'api_key' })),
    });
    expect(st.state).toBe('ready');
    expect(st.authMode).toBe('api-key');
  });

  it('claude not logged in → installed_unauthenticated with the OFFICIAL login command', async () => {
    const st = await getClaudeCodeStatus({ realExecution: false, prober: proberFor('claude', '') });
    expect(st.state).toBe('installed_unauthenticated');
    expect(st.nextCommand).toBe('claude auth login');
  });

  it('codex logged in via ChatGPT → subscription; official login hint', async () => {
    const st = await getCodexStatus({
      realExecution: false,
      prober: proberFor('codex', 'Logged in using ChatGPT'),
    });
    expect(st.state).toBe('ready');
    expect(st.authMode).toBe('subscription');
    const out = await getCodexStatus({ realExecution: false, prober: proberFor('codex', '') });
    expect(out.nextCommand).toBe('codex login');
  });
});
