#!/bin/bash
#
# Relationship Inbox OS — uninstall (macOS).
#
# Removes the locally-installed pilot app and all of its local data (the
# SQLite database, downloaded browser profile, logs inside the folder).
# Everything Relationship Inbox OS knows lives inside that one folder, so
# deleting it removes the app completely.
#
# It removes the app's OWN copy of Node (the ~/.rios-node folder the installer
# created on non-admin Macs) and the PATH line it added — but never a Node you
# already had, and never your Messages, Chrome, or LinkedIn account.
#
#   bash scripts/uninstall-student-macos.sh          # asks before deleting
#   bash scripts/uninstall-student-macos.sh --yes    # no prompt
#
# By design this only ever removes the pilot install folder
# (~/RelationshipInboxOS, or RIOS_INSTALL_DIR). It deliberately will NOT
# delete a folder just because the script happens to live inside it — so it
# can't wipe a development checkout you ran it from.

set -u

INSTALL_DIR="${RIOS_INSTALL_DIR:-$HOME/RelationshipInboxOS}"
ASSUME_YES=false
for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=true ;;
    -h|--help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  esac
done

is_app_root() {
  [ -f "$1/package.json" ] && grep -q '"relationship-inbox-os"' "$1/package.json" 2>/dev/null
}

# Resolve the target to a clean absolute path. ONLY the configured install
# location is ever a candidate — never the script's own directory.
TARGET="$(cd "$INSTALL_DIR" 2>/dev/null && pwd || echo "$INSTALL_DIR")"

if [ ! -d "$TARGET" ]; then
  echo "Nothing to remove — no install found at:"
  echo "  $INSTALL_DIR"
  echo "If it's elsewhere, run:  RIOS_INSTALL_DIR=/path/to/folder bash $0"
  exit 0
fi

if ! is_app_root "$TARGET"; then
  echo "Refusing to delete $TARGET — it doesn't look like the Relationship Inbox OS folder."
  exit 1
fi

# Extra guard: never delete a git working tree / dev checkout. The pilot
# install is a plain unzipped folder with no .git; a developer checkout has
# one. This stops the script wiping a real repo even if pointed at one.
if [ -e "$TARGET/.git" ]; then
  echo "Refusing to delete $TARGET — it's a git checkout, not a pilot install."
  echo "(The pilot install is a plain folder with no .git.)"
  exit 1
fi

echo ""
echo "This will permanently delete the pilot app and all its local data:"
echo "  $TARGET"
echo ""
echo "It will NOT remove Node.js, your Messages, your Chrome, or anything online."
echo ""

if [ "$ASSUME_YES" != true ]; then
  printf "Type 'delete' to confirm: "
  read -r reply
  if [ "$reply" != "delete" ]; then
    echo "Cancelled. Nothing was removed."
    exit 0
  fi
fi

# Stop a dev server still serving this folder, so the files aren't in use.
for port in "${DASHBOARD_PORT:-3100}" "${RUNNER_PORT:-4001}"; do
  pids="$(lsof -ti tcp:"$port" 2>/dev/null)"
  for pid in $pids; do
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
    case "$cwd" in
      "$TARGET"|"$TARGET"/*) kill "$pid" 2>/dev/null && echo "Stopped the running app (pid $pid)." ;;
    esac
  done
done

rm -rf "$TARGET" && echo "Removed $TARGET."

# Remove the app's own user-local Node + the PATH line the installer added.
# A Node you already had on your system is never touched.
RIOS_NODE_DIR="${RIOS_NODE_DIR:-$HOME/.rios-node}"
if [ -d "$RIOS_NODE_DIR" ]; then
  rm -rf "$RIOS_NODE_DIR" && echo "Removed the app's Node ($RIOS_NODE_DIR)."
fi
marker="# added by Relationship Inbox OS (Node on PATH)"
for rc in "$HOME/.zshrc" "$HOME/.bash_profile"; do
  [ -f "$rc" ] || continue
  if grep -qF "$marker" "$rc" 2>/dev/null; then
    tmp="$(mktemp)"
    awk -v m="$marker" 'index($0,m){skip=2} skip>0{skip--;next} {print}' "$rc" >"$tmp" \
      && mv "$tmp" "$rc" && echo "Removed the Node PATH line from $rc."
  fi
done

echo ""
echo "Done. To also remove the logs:  rm -rf \"$HOME/Library/Logs/RelationshipInboxOS\""
