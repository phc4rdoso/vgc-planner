#!/usr/bin/env bash
# Copies the whole sprites folder of robsonbittencourt/vgc-multicalc (src/app/assets/sprites: pokemon-champions,
# pokemon-home, items, types, menu) into public/sprites, so the app serves every icon itself instead of loading
# them from GitHub (raw.githubusercontent.com is rate limited and has no uptime guarantee).
# The repository is MIT-licensed, but the artwork belongs to its owners (Nintendo / The Pokémon Company), so
# public/sprites stays out of git: run this once per checkout, and before building for deployment.
set -euo pipefail

REPO="https://github.com/robsonbittencourt/vgc-multicalc.git"
SRC="src/app/assets/sprites"
DEST="$(cd "$(dirname "$0")/.." && pwd)/public/sprites"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Only the sprites folder is downloaded (sparse, blob-filtered clone), not the rest of the repository.
git clone --quiet --depth 1 --filter=blob:none --sparse "$REPO" "$tmp/repo"
git -C "$tmp/repo" sparse-checkout set "$SRC"

rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"
cp -R "$tmp/repo/$SRC" "$DEST"
echo "Sprites copied to $DEST:"
for dir in "$DEST"/*/; do echo "  $(basename "$dir"): $(find "$dir" -type f | wc -l | tr -d ' ') files"; done
