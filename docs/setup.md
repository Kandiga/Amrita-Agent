# Setup & configuration

`amrita setup` is a sectioned wizard. Run it with no arguments for the full menu, or jump to one section:

```bash
amrita setup            # menu: current state + sections
amrita setup model      # just the model/provider section
amrita setup telegram   # just the Telegram section
```

Sections: `model`, `credentials`, `telegram`, `connectors`, `endpoint`, `webui`, `review`.

It is **idempotent** — re-run it any time; a healthy provider survives a re-run, and your config is backed up to `config.json.bak` before any change. Nothing is ever faked, no tokens are printed, and a local-login provider is never asked for an API key.

## Choosing Amrita's brain

The model section groups providers and **recommends a working default** — it never lands you on a broken one:

```
Current: anthropic — incomplete (missing ANTHROPIC_API_KEY)

  0/auto. Auto — best available (currently claude-code (logged in (max)))

A) Local subscription / login
  1. Claude Code local login (subscription / Agent SDK credit)  [recommended]
       cost: your Claude subscription / Agent SDK credit — no API key  ·  status: logged in (max)
B) API key / aggregator
  2. Anthropic (Claude)   ·  status: incomplete (missing ANTHROPIC_API_KEY)
  ...
C) Local model
  7. Ollama (local)       ·  status: local endpoint http://127.0.0.1:11434/v1

Choose provider [1]:
```

- **Auto** (the default for a fresh install) resolves at runtime to the best available provider — Claude Code login → a configured API key → a local endpoint — so a brand-new box is never trapped on a broken default. Pick a concrete provider any time to pin it.
- **Claude Code local login** is keyless: if `claude auth status` says you're logged in, Amrita uses your subscription and **does not** ask for a key.
- API providers ask for their key (stored only in `~/.amrita/secrets.env`, mode 0600).

After choosing, you pick a model (a recommended default, known options, or any custom id). For Claude Code, `default` means "the model your subscription is set to".

## Recommendation rules (deterministic)

1. Keep the current provider if it is healthy/configured.
2. Otherwise prefer **Claude Code local login** when it is logged in.
3. Otherwise keep an explicitly-chosen login/local provider.
4. Otherwise use a configured API provider; else the first API provider (flagged as needing a key).

## Verify

```bash
amrita doctor
```

Doctor groups checks (`◆ Environment`, `◆ Model & providers`, `◆ Channels`, …) and ends with a numbered list of exactly which commands to run for any issue. After choosing Claude Code login it shows:

```
◆ Model & providers
  ✓ Model provider   claude-code: logged in via Claude Code (subscription / Agent SDK credit, max) / default
```

A fresh install on `auto` with Claude logged in is green immediately. `auto` with nothing configured yet is a **warning** ("run: amrita setup"), never a hard failure.

## Config & secrets

| File | Holds | Mode |
|---|---|---|
| `~/.amrita/config.json` | settings (provider, model, channels, connectors) — versioned, atomically written | 0600 |
| `~/.amrita/secrets.env` | API keys / bot tokens — `KEY=value`, single-line, atomically written | 0600 |

Secrets never appear in `config.json`, the database, logs, or the browser. The web Settings page shows only `sk-…abc` shapes.
