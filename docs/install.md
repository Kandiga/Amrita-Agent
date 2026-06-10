# Install, update, uninstall

## Requirements

- Node ≥ 23.6 (native TypeScript execution + built-in SQLite). Node 24 recommended.
- git
- Linux, macOS, or WSL2. A $5 VPS is plenty — there are zero runtime npm dependencies.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/Kandiga/Amrita-Agent/main/scripts/install.sh | bash
```

What it does (read it first — it's short):
1. Verifies Node ≥ 23.6 and git
2. Clones to `~/.local/share/amrita` (or updates an existing clone)
3. Writes a launcher to `~/.local/bin/amrita`
4. Optionally installs a systemd **user** service (`amrita daemon` at boot)

Then:

```bash
amrita setup    # choose a brain, then model → telegram, guided
amrita doctor   # checks with suggested fixes (incl. live login status)
amrita daemon   # web UI on 127.0.0.1:7460 + telegram + scheduler
```

`amrita daemon` prints a one-time login link for the web UI. Need another later? `amrita login-link`.

### Choosing Amrita's brain

`amrita setup` offers three groups:

- **A) Local subscription / login** — **Claude Code local login**. If you already use a Claude Pro/Max subscription, pick this: **no API key**. Amrita drives your installed `claude` CLI under your own login and never sees your credentials. First make sure you're signed in:
  ```bash
  claude auth login     # one-time, in your own terminal
  claude auth status    # should show "loggedIn": true
  ```
  Then `amrita doctor` will report `Model provider … logged in`. *(This is a conversational brain — for tool-using/coding work Amrita uses the Claude Code connector instead.)*
- **B) API key / aggregator** — Anthropic, OpenAI, OpenRouter, Gemini, xAI. Setup asks for the relevant key and stores it in `~/.amrita/secrets.env` (0600). *(Grok/xAI is API-key only.)*
- **C) Local model** — Ollama or any OpenAI-compatible localhost server; no key, just a running endpoint.

## Lifecycle commands

| Command | What it does |
|---|---|
| `amrita status` | daemon up? model? telegram? project count |
| `amrita doctor` | full diagnostic: node, db/FTS5, provider auth, telegram getMe, connectors, daemon health |
| `amrita update` | `git fetch` + fast-forward, then restart the service |
| `amrita uninstall` | prints exact removal steps — never deletes your data itself |

You can also ask Amrita herself ("run a status check") from any channel — `status`/`doctor` are honest about what they find.

## VPS deployment (Hostinger or any Linux box)

1. Install as above; say yes to the systemd service.
2. Put a TLS proxy in front — the daemon deliberately binds to localhost only:
   ```bash
   cp deploy/Caddyfile.example /etc/caddy/Caddyfile   # edit the domain
   systemctl reload caddy
   ```
3. Set the public URL so login links use your domain:
   ```bash
   amrita setup        # "Public URL" step → https://amrita.yourdomain.com
   ```
4. Telegram needs **no** inbound ports (long-polling).

## Backups

Everything that matters is in `~/.amrita/`:
- `amrita.db` — conversations, sessions, audit log
- `projects/*/vault/` — markdown memory (also nice to git-push somewhere private)
- `config.json` + `secrets.env`

A nightly `tar czf` of `~/.amrita` is a complete backup.

## Uninstall

```bash
amrita uninstall    # prints the steps; data removal is always your explicit call
```
