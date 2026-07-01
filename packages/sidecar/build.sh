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
PAYLOAD="$SIDECAR_DIR/pi-payload"

# Map the rust target triple to a bun --compile target so CI can cross-compile
# the sidecar per platform (bun build --compile is host-targeted by default).
# Unknown triples fall back to the host build (no --target). Windows binaries
# need a .exe suffix to match Tauri's externalBin lookup.
BUN_TARGET=""
BIN_EXT=""
case "$TRIPLE" in
  x86_64-unknown-linux-gnu)   BUN_TARGET="bun-linux-x64" ;;
  aarch64-unknown-linux-gnu)  BUN_TARGET="bun-linux-arm64" ;;
  x86_64-apple-darwin)        BUN_TARGET="bun-darwin-x64" ;;
  aarch64-apple-darwin)       BUN_TARGET="bun-darwin-arm64" ;;
  x86_64-pc-windows-msvc)     BUN_TARGET="bun-windows-x64"; BIN_EXT=".exe" ;;
  *) echo "warning: no bun target mapping for $TRIPLE; building for host" >&2 ;;
esac
BIN="$SIDECAR_DIR/pi-$TRIPLE$BIN_EXT"

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

# Plain --compile with NO --external: Pi statically imports jiti/static and
# typebox so bun bundles them into the binary, then exposes them to disk .ts
# extensions via virtualModules. Adding --external jiti/typebox would break disk
# extension loading (HOY-228). An extension's OWN node_modules deps resolve from
# disk at runtime, so nothing extra ships here for them.
echo "[2/3] bun build --compile -> $(basename "$BIN")"
if [ -n "$BUN_TARGET" ]; then
  bun build --compile --target="$BUN_TARGET" "$ENTRY" --outfile "$BIN"
else
  bun build --compile "$ENTRY" --outfile "$BIN"
fi
chmod +x "$BIN"

echo "[3/3] assembling pi-payload (PI_PACKAGE_DIR assets)"
rm -rf "$PAYLOAD" && mkdir -p "$PAYLOAD"
cp "$PKG_DIR/package.json" "$PAYLOAD/"
# HOY-222: brand the project-level config dir .pi -> .hoy. Pi derives
# CONFIG_DIR_NAME from pkg.piConfig.configDir (config.js) and reads this payload
# copy at runtime via PI_PACKAGE_DIR, so rewriting the one field flips every
# project-dir path (settings, packages, skills, prompts, trust, extensions). We
# edit only the payload copy that ships, not node_modules (keeps npm ci clean).
bun -e 'const f=process.argv[1]; const fs=require("fs"); const p=JSON.parse(fs.readFileSync(f)); p.piConfig={...p.piConfig,configDir:".hoy"}; fs.writeFileSync(f, JSON.stringify(p,null,2))' "$PAYLOAD/package.json"
# Fail loud if a future Pi package.json shape change drops the override.
CONFIG_DIR="$(bun -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1])).piConfig?.configDir))' "$PAYLOAD/package.json")"
if [ "$CONFIG_DIR" != ".hoy" ]; then
  echo "ERROR: payload piConfig.configDir is '$CONFIG_DIR', expected .hoy (HOY-222)" >&2
  exit 1
fi
cp -r "$DIST/modes/interactive/theme" "$PAYLOAD/theme"
cp -r "$DIST/core/export-html" "$PAYLOAD/export-html"
[ -d "$DIST/modes/interactive/assets" ] && cp -r "$DIST/modes/interactive/assets" "$PAYLOAD/assets"
[ -f "$PKG_DIR/README.md" ] && cp "$PKG_DIR/README.md" "$PAYLOAD/"
[ -f "$PKG_DIR/CHANGELOG.md" ] && cp "$PKG_DIR/CHANGELOG.md" "$PAYLOAD/"

echo
echo "done:"
echo "  binary:  $BIN"
echo "  payload: $PAYLOAD"
