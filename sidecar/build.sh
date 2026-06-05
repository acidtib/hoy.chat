#!/usr/bin/env bash
# Produce a self-contained Pi sidecar binary plus its asset payload for the
# current host. Output (gitignored, regenerated on demand):
#   sidecar/pi-<target-triple>     bun-compiled binary, named for Tauri externalBin
#   sidecar/pi-payload/            assets Pi's bun binary resolves via PI_PACKAGE_DIR
#
# Usage: sidecar/build.sh [target-triple]
# Default target-triple is the rustc host triple.
set -euo pipefail

SIDECAR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRIPLE="${1:-$(rustc -vV | sed -n 's/^host: //p')}"
PKG_DIR="$SIDECAR_DIR/pi-src/node_modules/@earendil-works/pi-coding-agent"
DIST="$PKG_DIR/dist"
ENTRY="$SIDECAR_DIR/pi-src/hoy-sidecar.ts"   # our SDK entry (runRpcMode + branding), not Pi's CLI
BIN="$SIDECAR_DIR/pi-$TRIPLE"
PAYLOAD="$SIDECAR_DIR/pi-payload"

echo "[1/3] installing pinned Pi into sidecar/pi-src"
( cd "$SIDECAR_DIR/pi-src" && npm ci --no-audit --no-fund 2>/dev/null || npm install --no-audit --no-fund )

if [ ! -f "$ENTRY" ]; then
  echo "ERROR: sidecar entry not found at $ENTRY" >&2
  exit 1
fi
if [ ! -d "$DIST" ]; then
  echo "ERROR: pi SDK not found at $DIST (run npm ci in sidecar/pi-src; Pi layout changed?)" >&2
  exit 1
fi

echo "[2/3] bun build --compile -> pi-$TRIPLE"
bun build --compile "$ENTRY" --outfile "$BIN"
chmod +x "$BIN"

echo "[3/3] assembling pi-payload (PI_PACKAGE_DIR assets)"
rm -rf "$PAYLOAD" && mkdir -p "$PAYLOAD"
cp "$PKG_DIR/package.json" "$PAYLOAD/"
cp -r "$DIST/modes/interactive/theme" "$PAYLOAD/theme"
cp -r "$DIST/core/export-html" "$PAYLOAD/export-html"
[ -d "$DIST/modes/interactive/assets" ] && cp -r "$DIST/modes/interactive/assets" "$PAYLOAD/assets"
[ -f "$PKG_DIR/README.md" ] && cp "$PKG_DIR/README.md" "$PAYLOAD/"
[ -f "$PKG_DIR/CHANGELOG.md" ] && cp "$PKG_DIR/CHANGELOG.md" "$PAYLOAD/"

echo
echo "done:"
echo "  binary:  $BIN"
echo "  payload: $PAYLOAD"
echo
echo "verify the Rust round-trip:  ( cd sidecar/m0-harness && cargo run )"
