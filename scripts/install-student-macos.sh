#!/bin/bash
#
# Tovi — student-pilot installer (macOS).
#
# Goal: a non-technical student pastes ONE command into Terminal and ends up
# with the app installed, the local database set up, and the app open in their
# browser — with NO GitHub account, git, Homebrew, nvm, Python, or Xcode.
#
# It is safe to run more than once. It never installs Homebrew, nvm, git,
# Python, or the Xcode command-line tools, and it never needs admin rights or
# your Mac password: if Node 22 is missing it installs Node into a user-owned
# folder (~/.rios-node) from Node's official tarball, so it works on managed /
# non-admin Macs (e.g. university accounts) too.
#
# Wherever it gets the app from, it installs into ONE predictable place:
# ~/RelationshipInboxOS. Two ways it gets the app, picked automatically:
#   • Run from inside an unzipped project folder  → copies the app into
#     ~/RelationshipInboxOS and installs it there (it does NOT run from
#     Downloads).
#   • Piped straight from a download link          → downloads the app zip and
#     installs it into ~/RelationshipInboxOS.
# Re-running over an existing ~/RelationshipInboxOS refreshes the code and
# KEEPS your data: .env, data/ (database + browser profiles), and logs/. The
# previous version is set aside until the new one is safely in place.
#
# Detailed output goes to a log file; the pilot only sees plain-English status.
#
# Overridable with environment variables (advanced / Richard only):
#   RIOS_APP_ZIP_URL       private URL of the app .zip (download mode)
#   RIOS_INSTALL_DIR       where to install        (default ~/RelationshipInboxOS)
#   RIOS_OPENAI_API_KEY    pre-fill the OpenAI key into .env
#   RIOS_NO_START=1        install but don't launch the app / open the browser
#   RIOS_NO_APP_BUNDLE=1   skip creating the Applications app icon
#
# Flags:
#   --dry-run     check the Mac and print the plan; change nothing
#   --no-start    do everything except launch the app
#   --skip-deps   relocate + write .env only; skip Node/npm/database/launch
#                 (used by the installer's own tests)
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
APP_NAME="${RIOS_APP_NAME:-Tovi}"

INSTALL_DIR="${RIOS_INSTALL_DIR:-$HOME/RelationshipInboxOS}"
APP_BUNDLE_DIR="${RIOS_APP_BUNDLE_DIR:-$HOME/Applications}"
NODE_MAJOR=22
NODE_RELEASE_DIR="https://nodejs.org/download/release/latest-v22.x"
# Where a user-local Node 22 is installed when one isn't already present.
# A plain folder in the home dir — no admin rights needed to write here.
RIOS_NODE_DIR="${RIOS_NODE_DIR:-$HOME/.rios-node}"
MIN_FREE_GB=4
REC_FREE_GB=8
MIN_MACOS_MAJOR=13            # Ventura
DASHBOARD_PORT="${DASHBOARD_PORT:-3100}"
DASHBOARD_URL="http://localhost:${DASHBOARD_PORT}"
RUNNER_PORT="${RUNNER_PORT:-4001}"
APP_START_TIMEOUT=180         # seconds to wait for the dashboard to come up

# Items inside the app folder that belong to the USER and must survive a
# re-install / update. Everything else is replaceable code.
PRESERVE_ITEMS=(.env .env.bak data logs)

DRY_RUN=false
NO_START=false
SKIP_DEPS=false
[ "${RIOS_NO_START:-}" = "1" ] && NO_START=true
NO_APP_BUNDLE=false
[ "${RIOS_NO_APP_BUNDLE:-}" = "1" ] && NO_APP_BUNDLE=true
MAINTENANCE_TOKEN=""
MAINTENANCE_ROOT=""
OPERATION_TOKEN=""
OPERATION_ROOT=""
OPERATION_HELPER=""

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --no-start) NO_START=true ;;
    --skip-deps) SKIP_DEPS=true; NO_START=true ;;
    -h|--help)
      sed -n '2,38p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'
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

# Show a path with the home directory shortened to ~ for friendlier output.
display_path() { printf '%s' "${1/#$HOME/~}"; }

# --------------------------------------------------------------------------
# Pre-flight environment checks
# --------------------------------------------------------------------------

check_macos() {
  step "Checking your Mac"

  if [ "$(uname -s)" != "Darwin" ]; then
    die "This installer is for macOS only. $APP_NAME needs a Mac for iMessage."
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
  if [ "$SKIP_DEPS" = true ]; then
    info "[skip-deps] skipping the production disk-space check"
    return 0
  fi
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

  if [ "$SKIP_DEPS" = true ]; then
    info "[skip-deps] skipping the Node.js check"
    return 0
  fi

  # A working Node 22 already first on PATH? Use it as-is.
  local have
  have="$(node_major || echo "")"
  if [ "$have" = "$NODE_MAJOR" ]; then
    ok "Node.js $(node -v) is already installed"
    return 0
  fi

  # A Node 22 we installed on a previous run? Put it back on PATH.
  if [ -x "$RIOS_NODE_DIR/bin/node" ]; then
    export PATH="$RIOS_NODE_DIR/bin:$PATH"; hash -r 2>/dev/null || true
    if [ "$(node_major || echo "")" = "$NODE_MAJOR" ]; then
      ok "Using the app's own Node.js $(node -v) ($(display_path "$RIOS_NODE_DIR"))"
      ensure_node_on_path
      return 0
    fi
  fi

  if [ -n "$have" ]; then
    info "Found Node.js $(node -v); the app is pinned to Node $NODE_MAJOR for reliability"
  else
    info "Node.js isn't installed yet"
  fi

  if [ "$DRY_RUN" = true ]; then
    warn "[dry-run] would install Node $NODE_MAJOR into $(display_path "$RIOS_NODE_DIR") (no admin needed)"
    return 0
  fi

  install_node_local
}

# A repeat install preserves data/, which includes SQLite's main database,
# WAL, browser profiles, and runtime state. The helper comes from the incoming
# source so even an older installed copy receives the current shutdown logic.
stop_existing_install() {
  local source="$1" helper
  [ -d "$INSTALL_DIR" ] || return 0
  is_app_root "$INSTALL_DIR" || return 0

  step "Checking for a running $APP_NAME"

  if [ "$DRY_RUN" = true ]; then
    warn "[dry-run] would stop any running copy at $(display_path "$INSTALL_DIR") before updating it"
    return 0
  fi

  helper="$source/scripts/stop-existing-install.mjs"
  [ -f "$helper" ] \
    || die "The installer is missing its safe shutdown helper. Download a fresh copy and try again."
  run "Stopping the existing app safely..." node "$helper" --app-dir "$INSTALL_DIR" \
    || die "Couldn't stop $APP_NAME safely. Quit the app and run the installer again."
  ok "Stopped the running app before updating its data"
}

begin_install_maintenance() {
  local root="$1" source="$2" helper token
  [ "$DRY_RUN" = true ] && return 0
  helper="$source/scripts/install-maintenance.mjs"
  [ -f "$helper" ] || return 1
  token="$(node "$helper" acquire --app-dir "$root" --owner-pid "$$" 2>>"$LOG_FILE")" || return 1
  [ -n "$token" ] || return 1
  MAINTENANCE_TOKEN="$token"
  MAINTENANCE_ROOT="$root"
  export RIOS_INSTALL_MAINTENANCE_TOKEN="$token"
}

begin_install_operation() {
  local root="$1" source="$2" helper token
  [ "$DRY_RUN" = true ] && return 0
  [ -n "$OPERATION_TOKEN" ] && return 0
  helper="$source/scripts/install-maintenance.mjs"
  [ -f "$helper" ] || return 1
  token="$(node "$helper" acquire-operation --app-dir "$root" --owner-pid "$$" 2>>"$LOG_FILE")" || return 1
  [ -n "$token" ] || return 1
  OPERATION_TOKEN="$token"
  OPERATION_ROOT="$root"
  OPERATION_HELPER="$helper"
  export RIOS_INSTALL_OPERATION_TOKEN="$token"
}

adopt_install_maintenance() {
  MAINTENANCE_ROOT="$1"
}

end_install_maintenance() {
  [ -n "$MAINTENANCE_TOKEN" ] || return 0
  local helper="$MAINTENANCE_ROOT/scripts/install-maintenance.mjs"
  if [ -f "$helper" ]; then
    node "$helper" release --app-dir "$MAINTENANCE_ROOT" --token "$MAINTENANCE_TOKEN" >>"$LOG_FILE" 2>&1 || true
  fi
  MAINTENANCE_TOKEN=""
  MAINTENANCE_ROOT=""
  unset RIOS_INSTALL_MAINTENANCE_TOKEN
}

end_install_operation() {
  [ -n "$OPERATION_TOKEN" ] || return 0
  local helper="$OPERATION_HELPER"
  if [ ! -f "$helper" ] && [ -n "${APP_DIR:-}" ]; then
    helper="$APP_DIR/scripts/install-maintenance.mjs"
  fi
  if [ -f "$helper" ]; then
    node "$helper" release-operation --app-dir "$OPERATION_ROOT" --token "$OPERATION_TOKEN" >>"$LOG_FILE" 2>&1 || true
  fi
  OPERATION_TOKEN=""
  OPERATION_ROOT=""
  OPERATION_HELPER=""
  unset RIOS_INSTALL_OPERATION_TOKEN
}

# Install Node 22 into a user-owned folder ($RIOS_NODE_DIR) from Node's
# official macOS tarball. No sudo, no admin rights, no Mac password — so it
# works on managed / non-admin accounts (e.g. university Macs). curl
# downloads are not Gatekeeper-quarantined, so the binary runs with no prompt.
install_node_local() {
  local arch na line name url sha tmp_tgz now
  arch="$(uname -m)"
  case "$arch" in
    arm64)  na="arm64" ;;
    x86_64) na="x64" ;;
    *)      na="x64"; warn "Unknown CPU $arch — trying the Intel (x64) Node build." ;;
  esac

  info "Looking up the latest Node $NODE_MAJOR build for $na..."
  line="$(curl -fsSL --max-time 30 "$NODE_RELEASE_DIR/SHASUMS256.txt" 2>>"$LOG_FILE" \
    | grep "darwin-$na\.tar\.gz$" | head -1)"
  name="$(printf '%s' "$line" | awk '{print $2}')"
  sha="$(printf '%s' "$line" | awk '{print $1}')"
  if [ -z "$name" ] || [ -z "$sha" ]; then
    die "Couldn't reach nodejs.org to download Node $NODE_MAJOR. Check your Wi-Fi and try again."
  fi
  url="$NODE_RELEASE_DIR/$name"
  tmp_tgz="${TMPDIR:-/tmp}/$name"

  info "Downloading $name (about 40 MB)..."
  if ! curl -fSL --progress-bar --max-time 600 "$url" -o "$tmp_tgz" 2>>"$LOG_FILE"; then
    die "Download of Node $NODE_MAJOR failed. Check your Wi-Fi and try again."
  fi

  # Verify the checksum before trusting the binary.
  if ! printf '%s  %s\n' "$sha" "$tmp_tgz" | shasum -a 256 -c - >>"$LOG_FILE" 2>&1; then
    rm -f "$tmp_tgz" 2>/dev/null
    die "The Node download didn't match its checksum. Try again; if it keeps failing, tell Richard."
  fi

  info "Installing Node into $(display_path "$RIOS_NODE_DIR") (no admin needed)..."
  rm -rf "$RIOS_NODE_DIR"
  mkdir -p "$RIOS_NODE_DIR" || die "Couldn't create $RIOS_NODE_DIR."
  if ! tar -xzf "$tmp_tgz" -C "$RIOS_NODE_DIR" --strip-components=1 >>"$LOG_FILE" 2>&1; then
    rm -f "$tmp_tgz" 2>/dev/null
    die "Couldn't unpack Node. The log has the details: $LOG_FILE"
  fi
  rm -f "$tmp_tgz" 2>/dev/null

  # Put it first on PATH for the rest of this install...
  export PATH="$RIOS_NODE_DIR/bin:$PATH"
  hash -r 2>/dev/null || true

  now="$(node_major || echo "")"
  if [ "$now" != "$NODE_MAJOR" ]; then
    die "Node $NODE_MAJOR installed into $RIOS_NODE_DIR but isn't runnable. The log has the details: $LOG_FILE"
  fi
  ok "Node.js $(node -v) installed (no admin needed)"

  # ...and for every future Terminal the pilot opens.
  ensure_node_on_path
}

# Persist $RIOS_NODE_DIR/bin on PATH for future shells, idempotently. The
# block is marked so the uninstaller can remove it cleanly.
ensure_node_on_path() {
  local bindir="$RIOS_NODE_DIR/bin"
  local marker="# added by Relationship Inbox OS (Node on PATH)"
  local rc
  for rc in "$HOME/.zshrc" "$HOME/.bash_profile"; do
    # zsh is the macOS default; only touch .bash_profile if it already exists.
    if [ "$rc" = "$HOME/.bash_profile" ] && [ ! -f "$rc" ]; then
      continue
    fi
    if [ -f "$rc" ] && grep -qF "$marker" "$rc" 2>/dev/null; then
      continue
    fi
    if {
      printf '\n%s\n' "$marker"
      printf 'export PATH="%s:$PATH"\n' "$bindir"
    } >>"$rc" 2>/dev/null; then
      info "Added Node to your PATH in $(display_path "$rc")"
    fi
  done
}

# --------------------------------------------------------------------------
# Locate the app source, then install it into ~/RelationshipInboxOS
# --------------------------------------------------------------------------

is_app_root() {
  [ -f "$1/package.json" ] && grep -q '"relationship-inbox-os"' "$1/package.json" 2>/dev/null
}

resolve_app_dir() {
  step "Finding the app"

  # Where are we installing FROM? The script lives inside the project
  # (scripts/...) when run from an unzipped folder; otherwise we download.
  local src_dir=""
  case "${BASH_SOURCE[0]:-}" in
    ""|/dev/fd/*|/dev/stdin|bash|sh) : ;;          # piped from curl — no path
    *) src_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd)" ;;
  esac

  local source=""
  if [ -n "$src_dir" ] && is_app_root "$src_dir"; then
    source="$src_dir"
  elif is_app_root "$PWD"; then
    source="$PWD"
  fi

  if [ -n "$source" ]; then
    if [ "$source" = "$INSTALL_DIR" ]; then
      # Already running from the install location — nothing to relocate.
      begin_install_operation "$INSTALL_DIR" "$source" \
        || die "Another installer or update is already changing $APP_NAME. Try again when it finishes."
      stop_existing_install "$source"
      begin_install_maintenance "$INSTALL_DIR" "$source" \
        || die "Couldn't reserve the app for installation. Quit $APP_NAME and try again."
      stop_existing_install "$source"
      APP_DIR="$INSTALL_DIR"
      ok "Using the app at $(display_path "$APP_DIR")"
      return 0
    fi
    ok "Found the app to install from: $(display_path "$source")"
    install_from_source "$source"
    return 0
  fi

  # No local copy → download it.
  download_app
}

# install_from_source SRC
#   Place the app code from SRC into $INSTALL_DIR and set APP_DIR=$INSTALL_DIR.
#   - Fresh target: copy SRC in.
#   - Existing install: refresh the code but KEEP the user's data (.env, data/,
#     logs). The old version is held as a backup until the new one is in place,
#     so user data is never deleted, even if the swap fails.
#   SRC is only ever read, never moved or deleted (it may hold the running
#   script), so the app never ends up running from Downloads.
install_from_source() {
  local source="$1"

  begin_install_operation "$INSTALL_DIR" "$source" \
    || die "Another installer or update is already changing $APP_NAME. Try again when it finishes."

  if is_app_root "$INSTALL_DIR"; then
    stop_existing_install "$source"
  fi

  if [ "$DRY_RUN" = true ]; then
    APP_DIR="$INSTALL_DIR"
    warn "[dry-run] would install into $(display_path "$INSTALL_DIR") (keeping any existing .env, data, logs)"
    return 0
  fi

  mkdir -p "$(dirname "$INSTALL_DIR")" || die "Couldn't create $(dirname "$INSTALL_DIR")."

  if [ ! -e "$INSTALL_DIR" ]; then
    step "Installing into $(display_path "$INSTALL_DIR")"
    cp -R "$source" "$INSTALL_DIR" || die "Couldn't copy the app into $INSTALL_DIR."
    begin_install_maintenance "$INSTALL_DIR" "$source" \
      || die "Couldn't reserve the new app for installation."
    ok "Installed into $(display_path "$INSTALL_DIR")"
  elif is_app_root "$INSTALL_DIR"; then
    step "Updating your existing install at $(display_path "$INSTALL_DIR")"
    info "Your settings (.env), data, and logs are kept"

    local staging backup item
    staging="${INSTALL_DIR}.new-$$"
    backup="${INSTALL_DIR}.previous"

    rm -rf "$staging"
    cp -R "$source" "$staging" || { rm -rf "$staging"; die "Couldn't stage the new app version."; }

    # Move the old app out of its launch path before reading any live data.
    # A second shutdown pass closes the tiny stop-to-rename race and verifies
    # the complete launcher/process tree under its new canonical path.
    rm -rf "$backup"
    mv "$INSTALL_DIR" "$backup" || { rm -rf "$staging"; die "Couldn't set aside the previous version — nothing was changed."; }
    if ! run "Confirming the old app is fully stopped..." \
         node "$source/scripts/stop-existing-install.mjs" --app-dir "$backup"; then
      mv "$backup" "$INSTALL_DIR" 2>/dev/null
      rm -rf "$staging"
      die "Couldn't stop $APP_NAME safely; restored your previous install."
    fi

    # With the old launch path absent and its full runtime stopped, the
    # preserved database, WAL, profiles, settings, and logs are stable.
    for item in "${PRESERVE_ITEMS[@]}"; do
      if [ -e "$backup/$item" ]; then
        rm -rf "$staging/$item"
        if ! cp -R "$backup/$item" "$staging/$item"; then
          rm -rf "$staging"
          mv "$backup" "$INSTALL_DIR" 2>/dev/null
          die "Couldn't preserve your existing $item; restored your previous install."
        fi
      fi
    done

    if ! begin_install_maintenance "$staging" "$source"; then
      rm -rf "$staging"
      mv "$backup" "$INSTALL_DIR" 2>/dev/null
      die "Couldn't reserve the new app for installation; restored your previous install."
    fi
    if ! mv "$staging" "$INSTALL_DIR"; then
      end_install_maintenance
      mv "$backup" "$INSTALL_DIR" 2>/dev/null
      die "Couldn't put the new version in place; restored your previous install."
    fi
    adopt_install_maintenance "$INSTALL_DIR"
    rm -rf "$backup"
    ok "Updated $(display_path "$INSTALL_DIR") (your data was kept)"
  else
    die "$(display_path "$INSTALL_DIR") already exists but doesn't look like $APP_NAME. Move it aside and run the installer again."
  fi

  APP_DIR="$INSTALL_DIR"
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
    warn "[dry-run] would download $APP_ZIP_URL and install into $(display_path "$INSTALL_DIR") (keeping any existing data)"
    return 0
  fi

  local tmp_zip extract_tmp inner
  tmp_zip="${TMPDIR:-/tmp}/relationship-inbox-os.zip"
  extract_tmp="${TMPDIR:-/tmp}/rios-extract-$$"

  info "Downloading $APP_NAME..."
  if ! curl -fSL --progress-bar --max-time 1200 "$APP_ZIP_URL" -o "$tmp_zip" 2>>"$LOG_FILE"; then
    die "Couldn't download the app. Check your Wi-Fi and the link, then try again."
  fi

  rm -rf "$extract_tmp"; mkdir -p "$extract_tmp"
  info "Unpacking..."
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

  # Same predictable destination + data-preserving install as the in-folder route.
  install_from_source "$inner"
  rm -rf "$extract_tmp" "$tmp_zip" 2>/dev/null
}

# --------------------------------------------------------------------------
# .env
# --------------------------------------------------------------------------

set_env_var() {
  # set_env_var FILE KEY VALUE  — replace KEY=... line in FILE, or append it.
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

  # Pin the local transcription model cache to an absolute path under data/
  # so it survives app updates and the runner + fetch script agree on it.
  set_env_var "$env_file" "TRANSCRIPTION_MODEL_DIR" "$APP_DIR/data/models"

  if [ -n "${RIOS_OPENAI_API_KEY:-}" ]; then
    set_env_var "$env_file" "OPENAI_API_KEY" "$RIOS_OPENAI_API_KEY"
    ok "OpenAI key saved"
  elif ! grep -q '^OPENAI_API_KEY=.\+' "$env_file" 2>/dev/null; then
    info "No AI key set. AI is optional and can be added safely in Tovi's setup assistant."
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
    warn "[dry-run] would run: npm run db:generate && node scripts/start-app.mjs --database-only"
    return 0
  fi

  if [ "$SKIP_DEPS" = true ]; then
    warn "[skip-deps] skipping npm install and database setup"
    return 0
  fi

  run "Installing app dependencies (npm install)..." npm install --include=dev \
    || die "Installing dependencies failed. The log has the details: $LOG_FILE"
  ok "Dependencies installed"

  run "Preparing the local database..." npm run db:generate \
    || die "Database setup (generate) failed. The log has the details: $LOG_FILE"
  run "Creating the local database..." node scripts/start-app.mjs --database-only \
    || die "Database setup (create) failed. The log has the details: $LOG_FILE"
  ok "Local database ready"

  # Build the optimised (production) dashboard now so the first launch is
  # instant instead of compiling pages on demand. Non-fatal: the launcher
  # rebuilds (or falls back to dev mode) if this step didn't finish.
  if run "Optimising the app for speed (one-time, about a minute)..." node scripts/start-app.mjs --prepare-only; then
    ok "App optimised"
  else
    warn "Couldn't pre-build the app now — the first launch will do it instead."
  fi
}

# --------------------------------------------------------------------------
# macOS app bundle
# --------------------------------------------------------------------------

create_app_bundle() {
  step "Creating the Mac app"

  if [ "$NO_APP_BUNDLE" = true ]; then
    info "Skipping the app icon (RIOS_NO_APP_BUNDLE=1)"
    return 0
  fi

  if [ "$DRY_RUN" = true ]; then
    warn "[dry-run] would create $APP_NAME.app in $(display_path "$APP_BUNDLE_DIR")"
    return 0
  fi

  if [ "$SKIP_DEPS" = true ]; then
    warn "[skip-deps] skipping the app bundle"
    return 0
  fi

  APP_NAME="$(cd "$APP_DIR" && node --input-type=module -e 'import { resolveAppName } from "./scripts/lib/branding.mjs"; process.stdout.write(resolveAppName())')" \
    || die "The configured app name is invalid. Check RIOS_APP_NAME in .env."

  local script="$APP_DIR/scripts/create-macos-app-bundle.mjs"
  if [ ! -f "$script" ]; then
    warn "Couldn't find the app bundle creator. You can still start from Terminal."
    return 0
  fi

  mkdir -p "$APP_BUNDLE_DIR" 2>>"$LOG_FILE" || {
    warn "Couldn't create $(display_path "$APP_BUNDLE_DIR"). You can still start from Terminal."
    return 0
  }

  if run "Creating $APP_NAME.app..." \
       node "$script" --app-dir "$APP_DIR" --out "$APP_BUNDLE_DIR" --node-dir "$RIOS_NODE_DIR"; then
    ok "Created $(display_path "$APP_BUNDLE_DIR")/$APP_NAME.app"
  else
    warn "Couldn't create the Mac app. You can still start from Terminal."
  fi
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
    [ $((waited % 15)) -eq 0 ] && info "Still starting up... (${waited}s)"
  done
  return 1
}

start_app() {
  local disp app_bundle
  disp="$(display_path "$APP_DIR")"
  app_bundle="$APP_BUNDLE_DIR/$APP_NAME.app"

  if [ "$NO_START" = true ] || [ "$DRY_RUN" = true ]; then
    step "Skipping app launch (per your request)"
    say ""
    say "  To start the app yourself:"
    say "    ${BOLD}open \"$APP_BUNDLE_DIR/$APP_NAME.app\"${RESET}"
    say "  Or from Terminal:"
    say "    ${BOLD}cd $disp && npm run start:student${RESET}"
    say "  Then open ${BOLD}$DASHBOARD_URL${RESET} in Chrome."
    return 0
  fi

  step "Starting $APP_NAME"
  cd "$APP_DIR" || die "Couldn't open the app folder $APP_DIR."

  if [ "$NO_APP_BUNDLE" != true ] && [ -d "$app_bundle" ]; then
    info "Opening the Mac app..."
    if ! open --env "RIOS_INSTALL_MAINTENANCE_TOKEN=$MAINTENANCE_TOKEN" "$app_bundle" >>"$LOG_FILE" 2>&1; then
      warn "Couldn't open the Mac app. Falling back to Terminal start."
    else
      if wait_for_dashboard; then
        ok "The app is up"
        open "$DASHBOARD_URL" >/dev/null 2>&1 || true
        print_success app
      else
        warn "The app is taking longer than usual to start."
        say "  Try opening $DASHBOARD_URL in Chrome. If it doesn't load, run the"
        say "  doctor check:  ${BOLD}cd $disp && npm run doctor${RESET}"
      fi
      return 0
    fi
  fi

  info "Launching the app..."
  # Keep the app attached to this Terminal so Ctrl+C stops it, the way the
  # fallback path describes. Its verbose output streams to the log. start-app
  # runs the optimised production build prepared above (with a dev fallback).
  node scripts/start-app.mjs >>"$LOG_FILE" 2>&1 &
  local dev_pid=$!
  trap 'printf "\n  Stopping the app...\n"; kill "$dev_pid" 2>/dev/null; wait "$dev_pid" 2>/dev/null; exit 0' INT TERM

  if wait_for_dashboard; then
    end_install_maintenance
    ok "The app is up"
    open "$DASHBOARD_URL" >/dev/null 2>&1 || true
    print_success terminal
  else
    end_install_maintenance
    warn "The app is taking longer than usual to start."
    say "  Try opening $DASHBOARD_URL in Chrome. If it doesn't load, run the"
    say "  doctor check:  ${BOLD}cd $disp && npm run doctor${RESET}"
  fi

  # Hand the Terminal to the running app.
  wait "$dev_pid"
}

print_success() {
  local mode="${1:-app}" disp
  disp="$(display_path "$APP_DIR")"
  if [ "$mode" = "terminal" ]; then
    cat <<EOF

  ${GREEN}${BOLD}$APP_NAME is running.${RESET}

  • It's open in your browser at  ${BOLD}$DASHBOARD_URL${RESET}
  • The app is installed at  ${BOLD}$disp${RESET}
  • ${BOLD}Leave this Terminal window open${RESET} - it keeps the app running.
  • To stop the app: click this window and press ${BOLD}Ctrl + C${RESET}.
  • To start it again later:
        ${BOLD}open "$APP_BUNDLE_DIR/$APP_NAME.app"${RESET}
    or  ${BOLD}cd $disp && npm run start:student${RESET}

  Next, Tovi's setup assistant lets you choose:
    1. The message sources you actually use
    2. Optional AI help and an optional Gemini key
    3. Optional local voice transcription
    4. Contacts, updates, and your first scan

  Setup guide:  docs/pilot/student-install-guide.md
  Stuck?        docs/pilot/student-install-troubleshooting.md
  Health check: npm run doctor

EOF
    return 0
  fi

  cat <<EOF

  ${GREEN}${BOLD}$APP_NAME is running.${RESET}

  • It's open in your browser at  ${BOLD}$DASHBOARD_URL${RESET}
  • The app is installed at  ${BOLD}$disp${RESET}
  • The Mac app is in ${BOLD}$(display_path "$APP_BUNDLE_DIR")/$APP_NAME.app${RESET}
  • Next time, open ${BOLD}$APP_NAME${RESET} from Applications or Launchpad.
  • You can close this Terminal once the browser is open.
  • To stop the app: quit ${BOLD}$APP_NAME${RESET} from the Dock.

  Next, Tovi's setup assistant lets you choose:
    1. The message sources you actually use
    2. Optional AI help and an optional Gemini key
    3. Optional local voice transcription
    4. Contacts, updates, and your first scan

  Setup guide:  docs/pilot/student-install-guide.md
  Stuck?        docs/pilot/student-install-troubleshooting.md
  Health check: npm run doctor

EOF
}

# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

main() {
  trap 'end_install_maintenance; end_install_operation' EXIT
  printf '\n%s%s%s installer%s\n' "$BOLD" "$BLUE" "$APP_NAME" "$RESET"
  printf '%sLog: %s%s\n' "$DIM" "$LOG_FILE" "$RESET"
  [ "$DRY_RUN" = true ] && printf '%s(dry run — nothing will be changed)%s\n' "$YELLOW" "$RESET"

  check_macos
  check_disk
  ensure_node
  resolve_app_dir
  ensure_env
  install_app
  create_app_bundle
  start_app
  end_install_maintenance
  end_install_operation
}

main "$@"
