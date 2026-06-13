#!/usr/bin/env bash
# Amrita v2 installer — one line, idempotent, honest.
#
#   curl -fsSL https://raw.githubusercontent.com/Kandiga/Amrita-Agent/v2-main/scripts/install.sh | bash
#
# What it does (and nothing more):
#   1. checks node >= 22.18, git, and pnpm (enables corepack if needed)
#   2. clones or fast-forwards the repo into ~/.local/share/amrita-v2
#   3. pnpm install (native build scripts are pre-approved in package.json)
#   4. puts `amrita` + `amritad` launchers on ~/.local/bin
#   5. offers an optional systemd user service (never without asking)
#
# It never asks for API keys or tokens — that is `amrita setup`, after install.
set -euo pipefail

REPO_URL="${AMRITA_REPO_URL:-https://github.com/Kandiga/Amrita-Agent.git}"
BRANCH="${AMRITA_BRANCH:-v2-main}"
INSTALL_DIR="${AMRITA_INSTALL_DIR:-$HOME/.local/share/amrita-v2}"
BIN_DIR="$HOME/.local/bin"

say()  { printf '%s\n' "$*"; }
step() { printf '→ %s\n' "$*"; }
ok()   { printf '✓ %s\n' "$*"; }
fail() { printf '✗ %s\n' "$*" >&2; exit 1; }

say ""
say "┌─────────────────────────────┐"
say "│  Amrita v2 — installer      │"
say "└─────────────────────────────┘"
say ""

# ── 1. prerequisites ─────────────────────────────────────────────────────────
step "checking node..."
command -v node >/dev/null 2>&1 || fail "node not found — install Node 22.18+ from https://nodejs.org"
NODE_VERSION="$(node --version | sed 's/^v//')"
NODE_MAJOR="${NODE_VERSION%%.*}"
NODE_MINOR_REST="${NODE_VERSION#*.}"
NODE_MINOR="${NODE_MINOR_REST%%.*}"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 18 ]; }; then
  fail "node $NODE_VERSION is too old — Amrita runs TypeScript natively and needs >= 22.18"
fi
ok "node $NODE_VERSION"

step "checking git..."
command -v git >/dev/null 2>&1 || fail "git not found — install it (e.g. sudo apt install git)"
ok "git $(git --version | awk '{print $3}')"

step "checking pnpm..."
if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    step "pnpm not found — enabling via corepack..."
    corepack enable >/dev/null 2>&1 || fail "corepack enable failed — install pnpm manually: npm install -g pnpm"
  else
    fail "pnpm not found — install it: npm install -g pnpm"
  fi
fi
ok "pnpm available (repo pins its own version via packageManager)"

# ── 2. clone or update ───────────────────────────────────────────────────────
if [ -d "$INSTALL_DIR/.git" ]; then
  step "existing install found — updating (fast-forward only)..."
  git -C "$INSTALL_DIR" fetch origin "$BRANCH"
  git -C "$INSTALL_DIR" merge --ff-only "origin/$BRANCH" || fail "local changes block the update — resolve them in $INSTALL_DIR"
  ok "updated to $(git -C "$INSTALL_DIR" rev-parse --short HEAD)"
else
  step "cloning $REPO_URL ($BRANCH)..."
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --branch "$BRANCH" --single-branch "$REPO_URL" "$INSTALL_DIR"
  ok "cloned to $INSTALL_DIR"
fi

# ── 3. dependencies ──────────────────────────────────────────────────────────
step "installing dependencies (native modules compile on first run)..."
(cd "$INSTALL_DIR" && pnpm install --frozen-lockfile)
ok "dependencies ready"

# ── 4. launchers (back up any existing ones first — recovery story) ──────────
step "installing launchers to $BIN_DIR..."
mkdir -p "$BIN_DIR"
NODE_BIN="$(command -v node)"
for name in amrita amritad; do
  if [ -e "$BIN_DIR/$name" ]; then
    cp -p "$BIN_DIR/$name" "$BIN_DIR/$name.bak" 2>/dev/null || true
  fi
done
printf '#!/usr/bin/env bash\nexec "%s" "%s/packages/cli/src/bin/amrita.ts" "$@"\n' \
  "$NODE_BIN" "$INSTALL_DIR" > "$BIN_DIR/amrita"
printf '#!/usr/bin/env bash\nexec "%s" "%s/packages/daemon/src/bin/amritad.ts" "$@"\n' \
  "$NODE_BIN" "$INSTALL_DIR" > "$BIN_DIR/amritad"
chmod 755 "$BIN_DIR/amrita" "$BIN_DIR/amritad"
ok "amrita + amritad installed (previous launchers, if any, saved as *.bak)"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "  ! $BIN_DIR is not on your PATH — add to your shell rc:"
     say "      export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac

# ── 5. optional systemd user service ─────────────────────────────────────────
is_wsl=0
grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null && is_wsl=1
if [ -t 0 ] && [ "${AMRITA_NO_SERVICE:-0}" != "1" ] && \
   systemctl --user is-system-running >/dev/null 2>&1; then
  printf 'Install a systemd user service so the daemon runs in the background? [y/N] '
  read -r reply
  case "$reply" in
    y|Y|yes)
      mkdir -p "$HOME/.config/systemd/user"
      sed -e "s|__NODE__|$NODE_BIN|g" -e "s|__DIR__|$INSTALL_DIR|g" \
        "$INSTALL_DIR/deploy/amritad.service" > "$HOME/.config/systemd/user/amritad.service"
      systemctl --user daemon-reload
      systemctl --user enable --now amritad
      ok "service running — logs: journalctl --user -u amritad -f"
      ;;
    *) say "  → skipped — start manually with: amritad --http --telegram" ;;
  esac
fi

# ── 6. post-install verification ─────────────────────────────────────────────
# Prove the install actually works before declaring success (Hermes lesson:
# verify after install). Runs the daemon's own doctor; tolerant of failure.
step "verifying the install..."
if "$NODE_BIN" "$INSTALL_DIR/packages/cli/src/bin/amrita.ts" health >/dev/null 2>&1; then
  ok "amrita answers — store schema + launchers verified"
else
  say "  ! post-install verification could not run amrita health"
  say "    try manually: amrita doctor"
fi

# ── done ─────────────────────────────────────────────────────────────────────
say ""
say "Done. Next:"
say "  amrita setup     # connect a brain (API key) + telegram — 2 minutes"
say "  amrita doctor    # verify everything, with exact fix commands"
if [ "$is_wsl" = "1" ]; then
  say "  amritad --http --telegram   # start in foreground (recommended on WSL)"
else
  say "  amritad --http --telegram   # start the daemon (or use the service above)"
fi
say ""
say "Your data lives in ~/.amrita (database + secrets.env, both machine-local)."
