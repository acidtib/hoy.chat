#!/usr/bin/env bash
# Linux release build wrapper (HOY-217), used as tauri-action's `tauriScript`.
#
# linuxdeploy and our bun-compiled `pi` sidecar do not coexist: linuxdeploy
# crashes running `ldd` on it (build failure), and otherwise rpath-rewrites it so
# the dynamically-linked bun binary loads the wrong libc and SIGSEGVs at runtime.
# Tauri's Linux updater needs the AppImage (deb/rpm are not auto-updatable), so we
# cannot just drop it. Fix in two parts:
#   1. A patched linuxdeploy-plugin-gtk.sh shelters the sidecar out of usr/bin
#      during the scan so the build does not crash.
#   2. After the build, repack the AppImage with the pristine sidecar (undoing the
#      rpath rewrite) and re-sign it so the updater signature matches.
#
# tauri-action invokes this as `<script> build <args>`, then collects the bundle
# artifacts and their .sig files from disk. Because we repack and re-sign in place
# (same paths), it harvests the corrected AppImage and latest.json stays valid.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
PRISTINE="$ROOT/sidecar/pi-$TRIPLE"
APPIMAGETOOL_VERSION="1.9.1"
CACHE="$HOME/.cache/tauri"

# 1. Pre-stage the patched GTK plugin so Tauri uses it instead of downloading the
#    upstream one. LINUXDEPLOY_SHELTER_BINS makes the shelter match our sidecar
#    by name (deterministic regardless of the runner's glibc/ldd behavior).
mkdir -p "$CACHE"
cp "$ROOT/scripts/linux/linuxdeploy-plugin-gtk.sh" "$CACHE/linuxdeploy-plugin-gtk.sh"
chmod +x "$CACHE/linuxdeploy-plugin-gtk.sh"
export LINUXDEPLOY_SHELTER_BINS="${LINUXDEPLOY_SHELTER_BINS:-pi}"

# 2. Run the real build (tauri build <args>); produces + signs the bundles.
bunx tauri "$@"

# 3. Repack the AppImage with the pristine sidecar, then re-sign.
BUNDLE_DIR="$ROOT/src-tauri/target/release/bundle/appimage"
APPIMAGE="$(find "$BUNDLE_DIR" -maxdepth 1 -name '*.AppImage' | head -n1)"
if [ -z "$APPIMAGE" ]; then
  echo "error: no AppImage produced in $BUNDLE_DIR" >&2
  exit 1
fi
if [ ! -f "$PRISTINE" ]; then
  echo "error: pristine sidecar not found at $PRISTINE" >&2
  exit 1
fi

TOOL="$CACHE/appimagetool-x86_64.AppImage"
if [ ! -f "$TOOL" ]; then
  curl -fsSL -o "$TOOL" \
    "https://github.com/AppImage/appimagetool/releases/download/${APPIMAGETOOL_VERSION}/appimagetool-x86_64.AppImage"
  chmod +x "$TOOL"
fi

WORK="$(mktemp -d)"
( cd "$WORK" && APPIMAGE_EXTRACT_AND_RUN=1 "$APPIMAGE" --appimage-extract >/dev/null )
cp -f "$PRISTINE" "$WORK/squashfs-root/usr/bin/pi"
chmod +x "$WORK/squashfs-root/usr/bin/pi"
rm -f "$APPIMAGE"
APPIMAGE_EXTRACT_AND_RUN=1 "$TOOL" "$WORK/squashfs-root" "$APPIMAGE"
rm -rf "$WORK"
echo "repacked AppImage with pristine sidecar: $APPIMAGE"

# Re-sign so the updater signature matches the repacked bytes. tauri-action reads
# the regenerated <AppImage>.sig when building latest.json. No-op signature if no
# signing key is set (e.g. PR builds), leaving the unsigned AppImage as-is.
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  rm -f "$APPIMAGE.sig"
  bunx tauri signer sign "$APPIMAGE"
  echo "re-signed: $APPIMAGE.sig"
fi
