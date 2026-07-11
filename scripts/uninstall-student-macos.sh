#!/bin/bash

set -u

APP_NAME="Tovi"
# Pre-rebrand name: bundles and folders created before the Tovi rename.
LEGACY_APP_NAME="Relationship Inbox OS"
INSTALL_DIR="${RIOS_INSTALL_DIR:-$HOME/RelationshipInboxOS}"
APP_BUNDLE_DIR="${RIOS_APP_BUNDLE_DIR:-$HOME/Applications}"
APP_SUPPORT_DIR="${RIOS_APP_SUPPORT_DIR:-$HOME/Library/Application Support/Relationship Inbox OS}"
LOG_DIR="${RIOS_LOG_DIR:-$HOME/Library/Logs/RelationshipInboxOS}"
NODE_DIR="${RIOS_NODE_DIR:-$HOME/.rios-node}"
ASSUME_YES=false
KEEP_DATA=false
DRY_RUN=false

for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=true ;;
    --keep-data) KEEP_DATA=true ;;
    --dry-run) DRY_RUN=true ;;
    -h|--help)
      cat <<EOF
Uninstall Tovi from this Mac.

  --yes        skip the confirmation prompt
  --keep-data  remove the app but keep messages, settings and logs
  --dry-run    print what would be removed
EOF
      exit 0
      ;;
  esac
done

is_app_root() {
  [ -f "$1/package.json" ] && grep -q '"relationship-inbox-os"' "$1/package.json" 2>/dev/null
}

bundle_id() {
  /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$1/Contents/Info.plist" 2>/dev/null || true
}

is_our_bundle() {
  case "$(bundle_id "$1")" in
    com.relationshipinboxos.desktop|com.relationshipinboxos.app) return 0 ;;
    *) return 1 ;;
  esac
}

append_unique_bundle() {
  local candidate="$1" existing
  [ -d "$candidate" ] || return 0
  for existing in "${BUNDLES[@]:-}"; do
    [ "$existing" = "$candidate" ] && return 0
  done
  BUNDLES+=("$candidate")
}

BUNDLES=()
append_unique_bundle "$APP_BUNDLE_DIR/$APP_NAME.app"
append_unique_bundle "/Applications/$APP_NAME.app"
append_unique_bundle "$APP_BUNDLE_DIR/$LEGACY_APP_NAME.app"
append_unique_bundle "/Applications/$LEGACY_APP_NAME.app"

SCRIPT_PATH="${BASH_SOURCE[0]:-}"
case "$SCRIPT_PATH" in
  *.app/Contents/Resources/app/scripts/*)
    append_unique_bundle "${SCRIPT_PATH%%.app/Contents/Resources/app/scripts/*}.app"
    ;;
esac

LEGACY_TARGET=""
if [ -d "$INSTALL_DIR" ]; then
  LEGACY_TARGET="$(cd "$INSTALL_DIR" 2>/dev/null && pwd || printf '%s' "$INSTALL_DIR")"
  if ! is_app_root "$LEGACY_TARGET"; then
    echo "Refusing to delete $LEGACY_TARGET because it does not look like Tovi."
    exit 1
  fi
  if [ -e "$LEGACY_TARGET/.git" ]; then
    echo "Refusing to delete $LEGACY_TARGET because it is a git checkout."
    exit 1
  fi
fi

HAS_DATA=false
if [ "$KEEP_DATA" != true ] && { [ -d "$APP_SUPPORT_DIR" ] || [ -d "$LOG_DIR" ]; }; then
  HAS_DATA=true
fi

if [ -z "$LEGACY_TARGET" ] && [ "${#BUNDLES[@]}" -eq 0 ] && [ "$HAS_DATA" != true ]; then
  echo "Nothing to remove. Tovi was not found in the configured locations."
  exit 0
fi

echo ""
echo "Tovi uninstaller"
echo ""
[ -n "$LEGACY_TARGET" ] && echo "App folder: $LEGACY_TARGET"
for bundle in ${BUNDLES[@]+"${BUNDLES[@]}"}; do echo "Mac app:    $bundle"; done
if [ "$KEEP_DATA" = true ]; then
  echo "Data:       kept at $APP_SUPPORT_DIR"
else
  [ -d "$APP_SUPPORT_DIR" ] && echo "App data:   $APP_SUPPORT_DIR"
  [ -d "$LOG_DIR" ] && echo "Logs:       $LOG_DIR"
fi
echo ""
echo "Messages, Contacts, Chrome and online accounts are never removed."
echo ""

if [ "$DRY_RUN" = true ]; then
  echo "Dry run complete. Nothing was changed."
  exit 0
fi

if [ "$ASSUME_YES" != true ]; then
  printf "Type 'delete' to confirm: "
  read -r reply
  if [ "$reply" != "delete" ]; then
    echo "Cancelled. Nothing was removed."
    exit 0
  fi
fi

for bundle in ${BUNDLES[@]+"${BUNDLES[@]}"}; do
  if ! is_our_bundle "$bundle"; then
    echo "Refusing to delete $bundle because its bundle identifier does not match Tovi."
    exit 1
  fi
done

for port in "${DASHBOARD_PORT:-3100}" "${RUNNER_PORT:-4001}"; do
  pids="$(lsof -ti tcp:"$port" 2>/dev/null || true)"
  for pid in $pids; do
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
    [ -n "$cwd" ] || continue
    case "$cwd" in
      "${LEGACY_TARGET:-/nonexistent}"|"${LEGACY_TARGET:-/nonexistent}"/*|*.app/Contents/Resources/app|*.app/Contents/Resources/app/*)
        kill "$pid" 2>/dev/null && echo "Stopped a Tovi service (pid $pid)."
        ;;
    esac
  done
done

if [ -n "$LEGACY_TARGET" ]; then
  rm -rf "$LEGACY_TARGET" && echo "Removed $LEGACY_TARGET."
fi

for bundle in ${BUNDLES[@]+"${BUNDLES[@]}"}; do
  if rm -rf "$bundle" 2>/dev/null; then
    echo "Removed $bundle."
  else
    echo "Could not remove $bundle. Quit the app, then drag it to the Trash in Finder."
  fi
done

if [ "$KEEP_DATA" != true ]; then
  [ ! -d "$APP_SUPPORT_DIR" ] || { rm -rf "$APP_SUPPORT_DIR" && echo "Removed $APP_SUPPORT_DIR."; }
  [ ! -d "$LOG_DIR" ] || { rm -rf "$LOG_DIR" && echo "Removed $LOG_DIR."; }
fi

if [ -n "$LEGACY_TARGET" ] && [ -d "$NODE_DIR" ]; then
  rm -rf "$NODE_DIR" && echo "Removed the legacy install's Node runtime ($NODE_DIR)."
fi

marker="# added by Relationship Inbox OS (Node on PATH)"  # marker text is historical; do not change or old installs stop matching
for rc in "$HOME/.zshrc" "$HOME/.bash_profile"; do
  [ -f "$rc" ] || continue
  if grep -qF "$marker" "$rc" 2>/dev/null; then
    tmp="$(mktemp)"
    awk -v m="$marker" 'index($0,m){skip=2} skip>0{skip--;next} {print}' "$rc" >"$tmp" \
      && mv "$tmp" "$rc" && echo "Removed the legacy Node PATH line from $rc."
  fi
done

echo ""
if [ "$KEEP_DATA" = true ]; then
  echo "Done. Your local data is still available for a future reinstall."
else
  echo "Done. Tovi and its local app data were removed."
fi
