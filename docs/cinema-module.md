# Cinema Studio module — install & link runbook

**Scope:** running the Amrita platform (`amritad`) together with the Cinema Studio module (repo `aba-adama-studio`) on one machine, per the federated integration (ADR-0028, phases 0–7 of the Cinema roadmap). One health command covers the pair: `amrita doctor`.

## What talks to what

```
Cinema SPA (browser) ──/rpc {id,method,params}──▶ amritad :7460   (platform front door)
        │                                             │ cinema.chat / cinema.assetAnalysis
        │ (all other channels: /run/{channel})        ▼ thin authenticated proxy
        └──────────────────────────────────▶ brain-bridge :8799   (module brain + generation)
```

- `amritad` (this repo): `pnpm amritad -- --http --port 7460`. `GET /health` is public; `POST /rpc` is bearer-gated (`AMRITA_AUTH_TOKEN`, or the ephemeral token printed once at startup).
- brain-bridge (Cinema repo `brain-bridge/server.mjs`, systemd `aba-brain-bridge`): port **8799** — a different process from amritad; do not conflate.
- For `cinema.chat` proxying, amritad needs (env NAMES; values never in any store): `BRAIN_BRIDGE_TOKEN` (the bridge bearer) and optionally `AMRITA_CINEMA_BRIDGE_URL` (default `http://127.0.0.1:8799`).

## First-run (verified on this machine, 2026-07-02)

1. Install/prepare amrita-v2 (`pnpm install`), start the daemon: `AMRITA_AUTH_TOKEN=<long-random> pnpm amritad -- --http --port 7460`.
2. `pnpm amrita doctor` → the **cinema** group live-probes the bridge and renders honest per-provider rows (ready / needs_key / needs_login / needs_setup / prompt_only / unavailable) with exact fix commands. `prompt_only` rows (video render, Midjourney) can never be green — by design.
3. In the Cinema app: Settings → **Amrita Platform** → set the amritad URL (`http://127.0.0.1:7460`) + bearer → Save & Check → honest `Connected` / `no daemon found`.
4. **Link to Amrita** (creates the project + a "Cinema sync" conversation) → **Sync to brain** (metadata digest only, <32 KB, media bytes never cross; re-syncs update ONE memory entry idempotently). Applied credit/destructive plan cards audit into the project's decisions/timeline.
5. Route: with a saved token the cinema chat verbs auto-route through amritad when it is detected (one session probe), silently falling back to brain-bridge otherwise; the Settings checkbox pins either route explicitly.

## Public-demo policy (amrita-agent.tech)

The deployed site works WITHOUT any local daemon: generation/reasoning go through the same-origin `/api/brain` proxy (access-code gated); the Amrita panel simply shows the honest "no daemon found" state (an `https` page probing `127.0.0.1` fails fast and safely). The local daemon pair is the *product*; the public site is the *teaser*. Nothing on the public path ever fakes a connected state.

## Sharing / secrets

- Secrets live only in env / `~/.amrita/secrets.env` (0600); stores and this doc carry env-var **NAMES** only.
- The Cinema project blob (IndexedDB) never leaves the browser except as the metadata digest; media bytes stay local. Project export/import JSON exists in the Cinema settings panel as insurance.
- Multi-user hosting is out of scope: Claude Max / ChatGPT subscriptions are used only via their official local CLIs, user-owned; multi-tenant paths require API keys.

**Caveat (honest):** the end-to-end runbook was executed on the development machine (2026-07-02) — amritad start, doctor, link/sync, chat round-trip, batch plan; a genuinely clean-machine install run is still pending and should be timed when first performed.
