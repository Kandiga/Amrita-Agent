# ADR-0010: `provider.connected` carries an optional account label

- **Status:** Accepted
- **Date:** 2026-06-10
- **Context:** The WO#2.2 CLI exposes `amrita account connect --provider P --label L`. The `accounts`
  table already has a `label` column (WO#1.1, `UNIQUE(provider, label)`), but no event carried it, so
  the reducer always inserted `label = NULL`. To make `--label` real, the creation event must carry it.

## Decision

Add an optional `label: string (1..200)` to the `provider.connected` payload. The reducer's
account-creation branch inserts it (`NULL` when absent). `provider.degraded`/`provider.restored` are
unchanged (they never create a row). `secret_ref` remains untouched by all provider events.

This is an additive, backward-compatible protocol change (the field is optional): existing producers
and tests that omit `label` still validate and project as before. Per the project rule, the taxonomy
change is recorded in this ADR.

## Consequences

`accounts.label` is now event-sourced. `UNIQUE(provider, label)` means two accounts for the same
provider must use distinct labels (or both omit it — multiple `NULL`s are allowed in SQLite). No
secret is involved; a label is a human display name.
