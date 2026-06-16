/**
 * Pure presentation helpers for the provider catalog (ADR-0025/0026). Kept out
 * of the component so the honest-state mapping is unit-testable without a DOM.
 * No secret value ever flows through here — env NAMES and status only.
 */
import type { ProviderCatalogEntryLite } from './api.ts';

type CatalogState = ProviderCatalogEntryLite['state'];
type CatalogGroup = ProviderCatalogEntryLite['group'];

/** Operator-facing label for each honest catalog state. */
export const CATALOG_STATE_LABEL: Record<CatalogState, string> = {
  ready: 'ready',
  needs_key: 'needs key',
  needs_login: 'needs login',
  missing_cli: 'missing CLI',
  needs_endpoint: 'needs endpoint',
  unavailable: 'unavailable',
};

/** Title for each provider group, in the order the Hub renders them. */
export const CATALOG_GROUP_LABEL: Record<CatalogGroup, string> = {
  login: 'Subscription / login',
  api_key: 'API key',
  local: 'Local endpoint',
};

export const CATALOG_GROUP_ORDER: readonly CatalogGroup[] = ['login', 'api_key', 'local'];

/**
 * Badge class for a catalog state. Only `ready` is "ok" (green) — and only the
 * daemon's live probe can produce `ready`. Everything that needs an operator
 * action is a warn; truly-unrunnable states are off. No fake green, ever.
 */
export function catalogBadgeClass(state: CatalogState): string {
  if (state === 'ready') return 'runtime-ok';
  if (state === 'missing_cli' || state === 'unavailable') return 'runtime-off';
  return 'runtime-warn';
}

/** Short imperative hint shown under a provider that is not yet ready. */
export function catalogStateHint(entry: ProviderCatalogEntryLite): string | undefined {
  if (entry.state === 'ready') return undefined;
  if (entry.fix) return entry.fix;
  if (entry.state === 'missing_cli' && entry.installHint) return entry.installHint;
  return 'amrita setup';
}

export interface CatalogGroupView {
  group: CatalogGroup;
  title: string;
  entries: ProviderCatalogEntryLite[];
}

/**
 * Group the flat catalog into the Hub's render order, dropping empty groups so
 * the UI never shows a header with nothing under it.
 */
export function groupCatalog(entries: ProviderCatalogEntryLite[]): CatalogGroupView[] {
  return CATALOG_GROUP_ORDER.map((group) => ({
    group,
    title: CATALOG_GROUP_LABEL[group],
    entries: entries.filter((e) => e.group === group),
  })).filter((g) => g.entries.length > 0);
}

/** A one-line dropdown label: provider id + honest state (so the picker never looks green-by-default). */
export function catalogOptionLabel(entry: ProviderCatalogEntryLite): string {
  return entry.state === 'ready' ? entry.id : `${entry.id} — ${CATALOG_STATE_LABEL[entry.state]}`;
}
