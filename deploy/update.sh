#!/usr/bin/env bash
# Pull the latest code and rebuild the UI. Idempotent.
#
# The UI is served straight from dist/ocabox-guider-ui on disk, so the build
# goes to a staging directory and replaces the served one only after it
# succeeded: a failed build leaves the running UI untouched.
#
# Needs `node` on PATH. Dependencies are not installed here; after a change
# of the dependencies in package.json run `npm install` first.
set -euo pipefail

cd "$(dirname "$0")/.."

command -v node >/dev/null || { echo "[update] node is not on PATH" >&2; exit 1; }

LIVE=dist/ocabox-guider-ui
NEXT=dist/.next
PREV=dist/.prev

echo "[update] pulling git..."
git pull --ff-only

echo "[update] building..."
rm -rf "$NEXT" "$PREV"
NG_CLI_ANALYTICS=false npx ng build --output-path "$NEXT"

if [ -d "$LIVE" ]; then mv "$LIVE" "$PREV"; fi
mv "$NEXT" "$LIVE"
rm -rf "$PREV"
echo "[update] done: $(git rev-parse --short HEAD)"
