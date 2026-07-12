# Amrita quality bar (how work lands in this repo)

- **Schema-first, ADR-gated:** protocol/store changes only via an ADR + reversible migration;
  every boundary crossing is Zod-parsed; `seq`-ordered events are the source of truth.
- **No junk drawer:** every new file has an owner module, import path, and test or doc
  reference. No disconnected components, placeholder routes, dead exports, scattered TODOs, or
  temporary report files — progress goes in the single upgrade ledger.
- **Centralize, don't patch:** if a concept appears in several places, extract the typed
  model/resolver (e.g. role resolution lives in one place: `resolveRole`).
- **Tests are behavioral:** pure reducers/builders/resolvers get unit tests; RPC/CLI get
  end-to-end flows; no brittle UI snapshots; no real network/provider/exec calls in tests —
  injectable fetch/runners with clearly-fake fixtures only.
- **UI is product, not console:** premium empty states that say what will appear and how;
  mobile/narrow reflow must work; RTL/mixed Hebrew-English via `dir` helpers on every
  user-content element; no raw JSON dumps or debug panels in user surfaces.
- **Errors are structured and value-free:** no stack traces or echoed secrets over RPC/CLI;
  deep ZodErrors map to `invalid_params`.
- **Gates before every commit** (`pnpm typecheck/lint/test` + web typecheck/test/build for web
  changes), full gates + precise secret scan + bounded live smoke before push.
