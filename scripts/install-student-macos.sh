#!/bin/bash
#
# Relationship Inbox OS — student-pilot installer (macOS).
#
# Goal: a non-technical student pastes ONE command into Terminal and ends up
# with the app installed, the local database set up, and the app open in their
# browser — with NO GitHub account, git, Homebrew, nvm, Python, or Xcode.
#
# It is safe to run more than once. It never installs Homebrew, nvm, git,
# Python, or the Xcode command-line tools. The only system change it can make
# is installing Node.js 22 from Node's own official installer, and only if a
# working Node 22 isn't already present.
#
# Two ways it runs, picked automatically:
#   • From inside an unzipped project folder  → installs the app in place.
#   • Piped straight from a download link      → downloads the app zip into
#     ~/RelationshipInboxOS, then installs it there.
#
# Detailed output goes to a log file; the pilot only sees plain-English status.
#
# Overridable with environment variables (advanced / Richard only):
#   RIOS_APP_ZIP_URL       private URL of the app .zip (download mode)
#   RIOS_INSTALL_DIR       where to install        (default ~/RelationshipInboxOS)
#   RIOS_OPENAI_API_KEY    pre-fill the OpenAI key into .env
#   RIOS_NO_START=1        install but don't launch the app / open the browser
#
# Flags:
#   --dry-run     check the Mac and print the plan; change nothing
#   --no-start    do everything except launch the app
#   --help        show this help

set -u

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------

# Richard: replace this with the private URL of the app .zip you host for
# pilots (or set RIOS_APP_ZIP_URL when sending the command). It is only used
# when the installer is run via a download link, not from inside the folder.
APP_ZIP_URL_DEFAULT="REPLACE_WITH_PRIVATE_ZIP_URL"
APP_ZIP_URL="${RIOS_APP_ZIP_URL:-$APP_ZIP_URL_DEFAULT}"

INSTALL_DIR="${RIOS_INSTALL_DIR:-$HOME/RelationshipInboxOS}"
NODE_MAJOR=22
NODE_RELEASE_DIR="https://nodejs.org/download/release/latest-v22.x"
MIN_FREE_GB=10
REC_FREE_GB=20
MIN_MACOS_MAJOR=13            # Ventura
DASHBOARD_PORT="${DASHBOARD_PORT:-3100}"
DASHBOARD_URL="http://localhost:${DASHBOARD_PORT}"
RUNNER_PORT="${RUNNER_PORT:-4001}"
APP_START_TIMEOUT=180         # seconds to wait for the dashboard to come up

DRY_RUN=false
NO_START=false
[ "${RIOS_NO_START:-}" = "1" ] && NO_START=true

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --no-start) NO_START=true ;;
    -h|--help)
      sed -n '2,40p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) ;;
  esac
done

# --------------------------------------------------------------------------
# Logging + pretty output
# --------------------------------------------------------------------------

LOG_DIR="$HOME/Library/Logs/RelationshipInboxOS"
mkdir -p "$LOG_DIR" 2>/dev/null || LOG_DIR="${TMPDIR:-/tmp}"
LOG_FILE="$LOG_DIR/install-$(date +%Y%m%d-%H%M%S).log"
: >"$LOG_FILE" 2>/dev/null || LOG_FILE="/dev/null"

if [ -t 1 ]; then
  BOLD="$(printf '\033[1m')"; DIM="$(printf '\033[2m')"
  GREEN="$(printf '\033[32m')"; YELLOW="$(printf '\033[33m')"
  RED="$(printf '\033[31m')"; BLUE="$(printf '\033[36m')"; RESET="$(printf '\033[0m')"
else
  BOLD=""; DIM=""; GREEN=""; YELLOW=""; RED=""; BLUE=""; RESET=""
fi

# log()  → file only.  say() → screen + file.
log()  { printf '%s\n' "$*" >>"$LOG_FILE" 2>/dev/null; }
say()  { printf '%s\n' "$*"; log "$*"; }
step() { printf '\n%s▸ %s%s\n' "$BOLD" "$*" "$RESET"; log ">>> $*"; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$*"; log "OK: $*"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$*"; log "WARN: $*"; }
info() { printf '  %s·%s %s\n' "$DIM" "$RESET" "$*"; log "INFO: $*"; }

die() {
  printf '\n  %s✗ %s%s\n' "$RED" "$*" "$RESET"
  printf '  %sThe full log is at:%s %s\n' "$DIM" "$RESET" "$LOG_FILE"
  printf '  %sSend that file to whoever shared this pilot with you.%s\n' "$DIM" "$RESET"
  log "FATAL: $*"
  exit 1
}

# run "human description" command args...  → runs quietly, log captures output.
run() {
  local desc="$1"; shift
  info "$desc"
  log "RUN: $*"
  if "$@" >>"$LOG_FILE" 2>&1; then
    return 0
  fi
  local code=$?
  log "EXIT $code: $*"
  return $code
}

# --------------------------------------------------------------------------
# Pre-flight environment checks
# --------------------------------------------------------------------------

check_macos() {
  step "Checking your Mac"

  if [ "$(uname -s)" != "Darwin" ]; then
    die "This installer is for macOS only. Relationship Inbox OS needs a Mac for iMessage."
  fi
  ok "macOS detected"

  local ver major
  ver="$(sw_vers -productVersion 2>/dev/null || echo "0")"
  major="${ver%%.*}"
  if [ "${major:-0}" -lt "$MIN_MACOS_MAJOR" ] 2>/dev/null; then
    warn "You're on macOS $ver. macOS Ventura (13) or newer is recommended."
  else
    ok "macOS version $ver"
  fi

  case "$(uname -m)" in
    arm64)  info "Apple Silicon Mac" ;;
    x86_64) info "Intel Mac" ;;
    *)      info "Unknown CPU ($(uname -m)) — continuing" ;;
  esac
}

check_disk() {
  # Available GB on the volume that holds the install target's parent.
  local target_parent free
  target_parent="$(dirname "$INSTALL_DIR")"
  [ -d "$target_parent" ] || target_parent="$HOME"
  free="$(df -g "$target_parent" 2>/dev/null | awk 'NR==2 {print $4}')"
  if [ -z "${free:-}" ]; then
    warn "Couldn't read free disk space — continuing."
    return 0
  fi
  if [ "$free" -lt "$MIN_FREE_GB" ] 2>/dev/null; then
    die "Only ${free}GB free. You need at least ${MIN_FREE_GB}GB (${REC_FREE_GB}GB recommended). Free up some space and try again."
  elif [ "$free" -lt "$REC_FREE_GB" ] 2>/dev/null; then
    warn "${free}GB free. That's enough to install, but ${REC_FREE_GB}GB is the comfortable amount."
  else
    ok "${free}GB free disk space"
  fi
}

# --------------------------------------------------------------------------
# Node.js 22
# --------------------------------------------------------------------------

node_major() {
  command -v node >/dev/null 2>&1 || return 1
  node -v 2>/dev/null | sed -E 's/^v([0-9]+)\..*/\1/'
}

ensure_node() {
  step "Checking Node.js (the engine the app runs on)"

  local have
  have="$(node_major || echo "")"
  if [ "$have" = "$NODE_MAJOR" ]; then
    ok "Node.js $(node -v) is already installed"
    return 0
  fi

  if [ -n "$have" ]; then
    info "Found Node.js $(node -v); the app is pinned to Node $NODE_MAJOR for reliability"
  else
    info "Node.js isn't installed yet"
  fi

  if [ "$DRY_RUN" = true ]; then
    warn "[dry-run] would install Node $NODE_MAJOR from $NODE_RELEASE_DIR"
    return 0
  fi

  install_node_pkg
}

install_node_pkg() {
  # Fetch the exact current Node 22 .pkg filename (universal: Apple Silicon +
  # Intel) from Node's official release directory. The .pkg installs Node
  # cleanly without Homebrew or nvm.
  local pkg_name pkg_url tmp_pkg
  info "Looking up the latest Node $NODE_MAJOR installer…"
  pkg_name="$(curl -fsSL --max-time 30 "$NODE_RELEASE_DIR/SHASUMS256.txt" 2>>"$LOG_FILE" \
    | awk '/\.pkg$/ {print $2; exit}')"
  if [ -z "${pkg_name:-}" ]; then
    die "Couldn't reach nodejs.org to download Node $NODE_MAJOR. Check your Wi-Fi and try again."
  fi
  pkg_url="$NODE_RELEASE_DIR/$pkg_name"
  tmp_pkg="${TMPDIR:-/tmp}/$pkg_name"

  info "Downloading $pkg_name (about 70 MB)…"
  if ! curl -fSL --progress-bar --max-time 600 "$pkg_url" -o "$tmp_pkg" 2>>"$LOG_FILE"; then
    die "Download of Node $NODE_MAJOR failed. Check your Wi-Fi and try again."
  fi

  say ""
  say "  macOS will now ask for your Mac password to install Node $NODE_MAJOR."
  say "  ${DIM}(This is the password you use to unlock your Mac.)${RESET}"
  if ! sudo installer -pkg "$tmp_pkg" -target / >>"$LOG_FILE" 2>&1; then
    die "Installing Node $NODE_MAJOR failed. The log has the details: $LOG_FILE"
  fi
  rm -f "$tmp_pkg" 2>/dev/null

  # The .pkg drops node/npm into /usr/local/bin; make sure this shell sees it.
  case ":$PATH:" in *":/usr/local/bin:"*) : ;; *) export PATH="/usr/local/bin:$PATH" ;; esac
  hash -r 2>/dev/null || true

  local now
  now="$(node_major || echo "")"
  if [ "$now" = "$NODE_MAJOR" ]; then
    ok "Node.js $(node -v) installed"
  elif [ -n "$now" ]; then
    warn "Node $NODE_MAJOR was installed, but '$(node -v)' is still first on your PATH."
    warn "Quit Terminal completely (Cmd+Q), reopen it, and run the command again."
    die "Node version needs a fresh Terminal to take effect."
  else
    die "Node $NODE_MAJOR installed but 'node' still isn't found. Quit and reopen Terminal, then retry."
  fi
}

# --------------------------------------------------------------------------
# Locate or download the app
# --------------------------------------------------------------------------

is_app_root() {
  [ -f "$1/package.json" ] && grep -q '"relationship-inbox-os"' "$1/package.json" 2>/dev/null
}

resolve_app_dir() {
  step "Finding the app"

  # In-place mode: the script lives inside the project (scripts/…). Works
  # whether run as ./scripts/install-student-macos.sh or by absolute path.
  local src_dir=""
  case "${BASH_SOURCE[0]:-}" in
    ""|/dev/fd/*|/dev/stdin|bash|sh) : ;;          # piped from curl — no path
    *) src_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd)" ;;
  esac

  if [ -n "$src_dir" ] && is_app_root "$src_dir"; then
    APP_DIR="$src_dir"
    ok "Installing from this folder: $APP_DIR"
    return 0
  fi
  if is_app_root "$PWD"; then
    APP_DIR="$PWD"
    ok "Installing from the current folder: $APP_DIR"
    return 0
  fi

  # Download mode.
  download_app
}

download_app() {
  if [ "$APP_ZIP_URL" = "$APP_ZIP_URL_DEFAULT" ]; then
    say ""
    say "  ${YELLOW}This copy of the installer doesn't have a download link set yet.${RESET}"
    say "  Ask Richard for the latest install command, or run this installer from"
    say "  inside the unzipped project folder instead."
    die "No app download URL configured (RIOS_APP_ZIP_URL is unset)."
  fi

  if [ "$DRY_RUN" = true ]; then
    APP_DIR="$INSTALL_DIR"
    warn "[dry-run] would download $APP_ZIP_URL into $INSTALL_DIR"
    return 0
  fi

  local tmp_zip extract_tmp inner
  tmp_zip="${TMPDIR:-/tmp}/relationship-inbox-os.zip"
  extract_tmp="${TMPDIR:-/tmp}/rios-extract-$$"

  if [ -d "$INSTALL_DIR" ] && is_app_root "$INSTALL_DIR"; then
    info "Found an existing install at $INSTALL_DIR — reusing it"
    APP_DIR="$INSTALL_DIR"
    return 0
  fi

  info "Downloading Relationship Inbox OS…"
  if ! curl -fSL --progress-bar --max-time 1200 "$APP_ZIP_URL" -o "$tmp_zip" 2>>"$LOG_FILE"; then
    die "Couldn't download the app. Check your Wi-Fi and the link, then try again."
  fi

  rm -rf "$extract_tmp"; mkdir -p "$extract_tmp"
  info "Unpacking…"
  if ! ditto -x -k "$tmp_zip" "$extract_tmp" >>"$LOG_FILE" 2>&1 && \
     ! unzip -q "$tmp_zip" -d "$extract_tmp" >>"$LOG_FILE" 2>&1; then
    die "The download couldn't be unzipped. Send the log to Richard: $LOG_FILE"
  fi

  # A zip of the repo usually contains a single top-level folder.
  inner="$extract_tmp"
  if ! is_app_root "$inner"; then
    local cand
    cand="$(find "$extract_tmp" -maxdepth 2 -name package.json -exec grep -l '"relationship-inbox-os"' {} \; 2>/dev/null | head -1)"
    [ -n "$cand" ] && inner="$(dirname "$cand")"
  fi
  is_app_root "$inner" || die "The download didn't contain the app. Send the log to Richard: $LOG_FILE"

  rm -rf "$INSTALL_DIR"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  mv "$inner" "$INSTALL_DIR" || die "Couldn't move the app into $INSTALL_DIR."
  rm -rf "$extract_tmp" "$tmp_zip" 2>/dev/null
  APP_DIR="$INSTALL_DIR"
  ok "Installed into $APP_DIR"
}

# --------------------------------------------------------------------------
# .env
# --------------------------------------------------------------------------

set_env_var() {
  # set_env_var FILE KEY VALUE  — replace KEY=… line in FILE, or append it.
  local file="$1" key="$2" value="$3" tmp
  tmp="$(mktemp)"
  if grep -q "^${key}=" "$file" 2>/dev/null; then
    # Rewrite the matching line, value treated literally.
    awk -v k="$key" -v v="$value" '
      $0 ~ "^" k "=" { print k "=" v; next } { print }
    ' "$file" >"$tmp" && mv "$tmp" "$file"
  else
    cp "$file" "$tmp" && printf '%s=%s\n' "$key" "$value" >>"$tmp" && mv "$tmp" "$file"
  fi
  rm -f "$tmp" 2>/dev/null
}

ensure_env() {
  step "Setting up your settings file (.env)"
  local env_file="$APP_DIR/.env"
  local abs_db="file:$APP_DIR/data/inbox-os.sqlite"

  if [ "$DRY_RUN" = true ]; then
    warn "[dry-run] would create/normalise $env_file (DATABASE_URL → $abs_db)"
    return 0
  fi

  if [ ! -f "$env_file" ]; then
    if [ -f "$APP_DIR/.env.example" ]; then
      cp "$APP_DIR/.env.example" "$env_file"
      ok "Created .env from the template"
    else
      : >"$env_file"
      warn "No .env.example found — created a blank .env"
    fi
  else
    cp "$env_file" "$env_file.bak" 2>/dev/null
    info "Existing .env kept (backed up to .env.bak)"
  fi

  # Always pin DATABASE_URL to an absolute path so the runner and the
  # database setup step never disagree on which file to use.
  set_env_var "$env_file" "DATABASE_URL" "$abs_db"
  ok "Database path set to $APP_DIR/data"

  # Personal Chrome mode is the recommended pilot default.
  set_env_var "$env_file" "BROWSER_PROFILE_MODE" "personal"

  if [ -n "${RIOS_OPENAI_API_KEY:-}" ]; then
    set_env_var "$env_file" "OPENAI_API_KEY" "$RIOS_OPENAI_API_KEY"
    ok "OpenAI key saved"
  elif ! grep -q '^OPENAI_API_KEY=.\+' "$env_file" 2>/dev/null; then
    warn "No OpenAI key set yet — Richard will give you one to paste into .env"
  fi
}

# --------------------------------------------------------------------------
# Install dependencies + database
# --------------------------------------------------------------------------

install_app() {
  step "Installing the app (this is the long part — a few minutes)"
  cd "$APP_DIR" || die "Couldn't open the app folder $APP_DIR."

  if [ "$DRY_RUN" = true ]; then
    warn "[dry-run] would run: npm install --include=dev"
    warn "[dry-run] would run: npx playwright install chromium"
    warn "[dry-run] would run: npm run db:generate && npm run db:push"
    return 0
  fi

  run "Installing app dependencies (npm install)…" npm install --include=dev \
    || die "Installing dependencies failed. The log has the details: $LOG_FILE"
  ok "Dependencies installed"

  run "Installing the browser for LinkedIn (Chromium only)…" npx playwright install chromium \
    || warn "Couldn't install the LinkedIn browser now — you can retry later with: npx playwright install chromium"
  ok "LinkedIn browser ready"

  run "Preparing the local database…" npm run db:generate \
    || die "Database setup (generate) failed. The log has the details: $LOG_FILE"
  run "Creating the local database…" npm run db:push \
    || die "Database setup (create) failed. The log has the details: $LOG_FILE"
  ok "Local database ready"
}

# --------------------------------------------------------------------------
# Start the app
# --------------------------------------------------------------------------

wait_for_dashboard() {
  local waited=0
  while [ "$waited" -lt "$APP_START_TIMEOUT" ]; do
    if curl -fsS --max-time 3 "$DASHBOARD_URL" >/dev/null 2>&1; then
      return 0
    fi
    sleep 3; waited=$((waited + 3))
    [ $((waited % 15)) -eq 0 ] && info "Still starting up… (${waited}s)"
  done
  return 1
}

start_app() {
  if [ "$NO_START" = true ] || [ "$DRY_RUN" = true ]; then
    step "Skipping app launch (per your request)"
    say ""
    say "  To start the app yourself:"
    say "    ${BOLD}cd \"$APP_DIR\" && npm run dev${RESET}"
    say "  Then open ${BOLD}$DASHBOARD_URL${RESET} in Chrome."
    return 0
  fi

  step "Starting Relationship Inbox OS"
  cd "$APP_DIR" || die "Couldn't open the app folder $APP_DIR."

  info "Launching the app (the first start takes a minute)…"
  # Keep the dev server attached to this Terminal so Ctrl+C stops it, the way
  # the guide describes. Its verbose output streams to the log.
  npm run dev >>"$LOG_FILE" 2>&1 &
  local dev_pid=$!
  trap 'printf "\n  Stopping the app…\n"; kill "$dev_pid" 2>/dev/null; wait "$dev_pid" 2>/dev/null; exit 0' INT TERM

  if wait_for_dashboard; then
    ok "The app is up"
    open "$DASHBOARD_URL" >/dev/null 2>&1 || true
    print_success
  else
    warn "The app is taking longer than usual to start."
    say "  Try opening $DASHBOARD_URL in Chrome. If it doesn't load, run the"
    say "  doctor check:  ${BOLD}cd \"$APP_DIR\" && node scripts/doctor.mjs${RESET}"
  fi

  # Hand the Terminal to the running app.
  wait "$dev_pid"
}

print_success() {
  cat <<EOF

  ${GREEN}${BOLD}Relationship Inbox OS is running.${RESET}

  • It's open in your browser at  ${BOLD}$DASHBOARD_URL${RESET}
  • ${BOLD}Leave this Terminal window open${RESET} — it keeps the app running.
  • To stop the app: click this window and press ${BOLD}Ctrl + C${RESET}.
  • To start it again later:  ${BOLD}cd "$APP_DIR" && npm run dev${RESET}

  Next, the app walks you through:
    1. iMessage access   (a one-time macOS permission)
    2. Connecting LinkedIn
    3. Your first scan

  Setup guide:  docs/pilot/student-install-guide.md
  Stuck?        docs/pilot/student-install-troubleshooting.md
  Health check: node scripts/doctor.mjs

EOF
}

# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

main() {
  printf '\n%s%sRelationship Inbox OS — installer%s\n' "$BOLD" "$BLUE" "$RESET"
  printf '%sLog: %s%s\n' "$DIM" "$LOG_FILE" "$RESET"
  [ "$DRY_RUN" = true ] && printf '%s(dry run — nothing will be changed)%s\n' "$YELLOW" "$RESET"

  check_macos
  check_disk
  ensure_node
  resolve_app_dir
  ensure_env
  install_app
  start_app
}

main "$@"
