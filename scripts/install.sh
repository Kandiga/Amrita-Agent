#!/usr/bin/env bash
# Amrita Agent installer — Linux/macOS/WSL2.
# Installs to ~/.local/share/amrita, symlinks `amrita`, optionally installs a systemd service.
set -euo pipefail

REPO="${AMRITA_REPO:-https://github.com/Kandiga/Amrita-Agent.git}"
INSTALL_DIR="${AMRITA_INSTALL_DIR:-$HOME/.local/share/amrita}"
BIN_DIR="$HOME/.local/bin"

say()  { printf '\033[1m[amrita]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[amrita] %s\033[0m\n' "$*" >&2; exit 1; }

# --- node >= 23.6 ---
need_node=1
if command -v node >/dev/null 2>&1; then
  ver="$(node -v | sed 's/^v//')"
  major="${ver%%.*}"; rest="${ver#*.}"; minor="${rest%%.*}"
  if [ "$major" -gt 23 ] || { [ "$major" -eq 23 ] && [ "$minor" -ge 6 ]; }; then need_node=0; fi
fi
if [ "$need_node" -eq 1 ]; then
  fail "Node >= 23.6 is required (native TypeScript + sqlite). Install it first: https://nodejs.org or 'curl -fsSL https://fnm.vercel.app/install | bash'"
fi

command -v git >/dev/null 2>&1 || fail "git is required."

# --- fetch / update checkout ---
if [ -d "$INSTALL_DIR/.git" ]; then
  say "existing install found — updating"
  git -C "$INSTALL_DIR" pull --ff-only origin main
else
  say "cloning to $INSTALL_DIR"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --depth 1 "$REPO" "$INSTALL_DIR"
fi

# --- launcher ---
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/amrita" <<EOF
#!/usr/bin/env bash
exec node "$INSTALL_DIR/src/cli/main.ts" "\$@"
EOF
chmod +x "$BIN_DIR/amrita"
say "installed launcher: $BIN_DIR/amrita"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "NOTE: add $BIN_DIR to your PATH (e.g. echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc)";;
esac

# --- environment notes ---
is_wsl=0
if grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null; then is_wsl=1; fi
have_user_systemd=0
if command -v systemctl >/dev/null 2>&1 && systemctl --user is-system-running >/dev/null 2>&1; then
  have_user_systemd=1
fi

# --- optional systemd service (only when a user manager actually exists) ---
if [ "$have_user_systemd" = "1" ] && [ "${AMRITA_NO_SERVICE:-0}" != "1" ]; then
  read -r -p "Install a systemd user service so Amrita runs at boot? [y/N] " yn || yn=n
  if [ "${yn,,}" = "y" ]; then
    mkdir -p "$HOME/.config/systemd/user"
    sed "s|__NODE__|$(command -v node)|g; s|__DIR__|$INSTALL_DIR|g" \
      "$INSTALL_DIR/deploy/amrita.service" > "$HOME/.config/systemd/user/amrita.service"
    systemctl --user daemon-reload
    systemctl --user enable --now amrita
    say "service installed (journalctl --user -u amrita -f for logs)"
  fi
elif [ "$is_wsl" = "1" ]; then
  say "WSL detected without a systemd user manager — run Amrita in the foreground (recommended on WSL):"
  say "  amrita daemon"
  say "  (to enable systemd on WSL: add '[boot]\\nsystemd=true' to /etc/wsl.conf, then 'wsl --shutdown')"
fi

say "done. Next:"
say "  amrita setup    # choose a brain (Claude Code login / API key / local), model, channels"
say "  amrita doctor   # verify everything (incl. live login status)"
if [ "$is_wsl" = "1" ]; then
  say "  amrita daemon   # start in foreground (recommended on WSL) — prints a web login link"
else
  say "  amrita daemon   # start (prints a web login link), or: amrita service install"
fi
