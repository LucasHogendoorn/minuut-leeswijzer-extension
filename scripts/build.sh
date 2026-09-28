#!/bin/zsh
# Build the Chrome Web Store package: only what the extension runs, nothing
# from development (dev-config.json, README, scripts/).
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")
OUT="dist/minuut-leeswijzer-$VERSION.zip"
rm -rf dist/pkg && mkdir -p dist/pkg
cp -R manifest.json src options fonts icons dist/pkg/
find dist/pkg -name ".DS_Store" -delete

# Refuse to ship anything that looks like a secret or a dev override.
if grep -rIl -E "vck_[A-Za-z0-9]{20,}|AI_GATEWAY_API_KEY=|BEGIN (RSA|EC|OPENSSH) PRIVATE KEY" dist/pkg; then
  echo "secret-like content found; aborting" >&2; exit 1
fi
[ ! -e dist/pkg/dev-config.json ] || { echo "dev-config.json in package; aborting" >&2; exit 1; }
grep -q '127.0.0.1' dist/pkg/manifest.json && { echo "localhost permission in manifest; aborting" >&2; exit 1; }

rm -f "$OUT" && (cd dist/pkg && zip -qr "../$(basename "$OUT")" .)
echo "$OUT ($(du -h "$OUT" | cut -f1))"
