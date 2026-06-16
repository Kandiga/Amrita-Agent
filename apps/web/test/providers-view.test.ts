import { describe, expect, it } from 'vitest';
import type { ProviderCatalogEntryLite } from '../src/api.ts';
import {
  CATALOG_STATE_LABEL,
  catalogBadgeClass,
  catalogOptionLabel,
  catalogStateHint,
  groupCatalog,
} from '../src/providers-view.ts';

function entry(over: Partial<ProviderCatalogEntryLite>): ProviderCatalogEntryLite {
  return {
    id: 'anthropic',
    title: 'Anthropic',
    group: 'api_key',
    authMode: 'api_key',
    defaultModel: 'claude-sonnet',
    executable: true,
    state: 'needs_key',
    detail: 'no key configured',
    ...over,
  };
}

describe('providers-view', () => {
  it('only "ready" maps to the ok (green) badge — no fake green', () => {
    expect(catalogBadgeClass('ready')).toBe('runtime-ok');
    // operator-actionable states are warns, truly-unrunnable are off
    expect(catalogBadgeClass('needs_key')).toBe('runtime-warn');
    expect(catalogBadgeClass('needs_login')).toBe('runtime-warn');
    expect(catalogBadgeClass('needs_endpoint')).toBe('runtime-warn');
    expect(catalogBadgeClass('missing_cli')).toBe('runtime-off');
    expect(catalogBadgeClass('unavailable')).toBe('runtime-off');
  });

  it('labels every catalog state', () => {
    for (const state of Object.keys(CATALOG_STATE_LABEL) as ProviderCatalogEntryLite['state'][]) {
      expect(CATALOG_STATE_LABEL[state]).toBeTruthy();
    }
  });

  it('groups in render order and drops empty groups', () => {
    const groups = groupCatalog([
      entry({ id: 'local', group: 'local', state: 'needs_endpoint' }),
      entry({ id: 'claude-code', group: 'login', state: 'needs_login' }),
      entry({ id: 'openai', group: 'api_key', state: 'ready' }),
    ]);
    expect(groups.map((g) => g.group)).toEqual(['login', 'api_key', 'local']);
    // an empty group never produces a header
    expect(groupCatalog([entry({ group: 'api_key' })]).map((g) => g.group)).toEqual(['api_key']);
  });

  it('prefers the explicit fix, then install hint, then a setup fallback for hints', () => {
    expect(catalogStateHint(entry({ state: 'ready' }))).toBeUndefined();
    expect(catalogStateHint(entry({ state: 'needs_key', fix: 'amrita setup' }))).toBe(
      'amrita setup',
    );
    expect(catalogStateHint(entry({ state: 'missing_cli', installHint: 'npm i -g x' }))).toBe(
      'npm i -g x',
    );
    expect(catalogStateHint(entry({ state: 'unavailable' }))).toBe('amrita setup');
  });

  it('option label shows the honest state unless ready', () => {
    expect(catalogOptionLabel(entry({ id: 'openai', state: 'ready' }))).toBe('openai');
    expect(catalogOptionLabel(entry({ id: 'openai', state: 'needs_key' }))).toBe(
      'openai — needs key',
    );
  });
});
