#!/usr/bin/env bash
# Copies the Pokémon and item sprites from robsonbittencourt/vgc-multicalc into public/sprites so the app can
# serve them itself (hot-linking raw.githubusercontent.com is rate limited and has no uptime guarantee).
# The artwork belongs to its respective owners: check the licence/permission before redistributing it.
set -euo pipefail

REPO="https://github.com/robsonbittencourt/vgc-multicalc.git"
SRC="src/app/assets/sprites"
DEST="$(cd "$(dirname "$0")/.." && pwd)/public/sprites"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

git clone --quiet --depth 1 --filter=blob:none --sparse "$REPO" "$tmp/repo"
git -C "$tmp/repo" sparse-checkout set "$SRC/pokemon-champions" "$SRC/items"

mkdir -p "$DEST"
rm -rf "$DEST/pokemon-champions" "$DEST/items"
cp -R "$tmp/repo/$SRC/pokemon-champions" "$DEST/pokemon-champions"
cp -R "$tmp/repo/$SRC/items" "$DEST/items"
echo "Sprites copied to $DEST ($(find "$DEST" -type f | wc -l | tr -d ' ') files)"
