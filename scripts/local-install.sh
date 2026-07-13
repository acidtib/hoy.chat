#!/usr/bin/env bash
# Build and install Hoy locally as the daily driver (HOY-207). Linux only; this
# is the dogfooding stopgap that predates the signed release pipeline
# (.github/workflows/release.yml now ships per-platform bundles).
#
# Installs to:
#   ~/.local/share/hoy-desktop/   app binary, sidecar binary, pi-payload
#   ~/.local/bin/hoy              launcher
#   ~/.local/share/applications/hoy-desktop.desktop
#
# The installed app resolves its sidecar and payload beside the executable.
# Do not pin those paths in the launcher: after a self-update the executable is
# an AppImage whose matching sidecar lives inside its mounted resources. Pinning
# the original local-install artifacts would mix protocol versions.
#
# Usage: bun run local:install   (re-run to upgrade)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
APP_DIR="$HOME/.local/share/hoy-desktop"
BIN_DIR="$HOME/.local/bin"
DESKTOP_DIR="$HOME/.local/share/applications"
ICON_DIR="$HOME/.local/share/icons/hicolor/128x128/apps"

echo "[1/4] sidecar build"
"$ROOT/packages/sidecar/build.sh" "$TRIPLE"

echo "[2/4] release build (no bundle; the final link sits quiet for a minute or two)"
( cd "$ROOT/apps/desktop" && bun run tauri build --no-bundle )

echo "[3/4] install to $APP_DIR"
mkdir -p "$APP_DIR" "$BIN_DIR" "$DESKTOP_DIR" "$ICON_DIR"
install -m 755 "$ROOT/apps/desktop/src-tauri/target/release/hoy-desktop" "$APP_DIR/hoy-desktop"
# Match Tauri's packaged externalBin name. build.sh keeps the target triple on
# the source artifact, while packaged binaries have it stripped.
install -m 755 "$ROOT/packages/sidecar/hoy-pi-$TRIPLE" "$APP_DIR/hoy-pi"
rm -rf "$APP_DIR/pi-payload"
cp -r "$ROOT/packages/sidecar/pi-payload" "$APP_DIR/pi-payload"
install -m 644 "$ROOT/apps/desktop/src-tauri/icons/128x128.png" "$ICON_DIR/hoy-desktop.png"

echo "[4/4] launcher and desktop entry"
cat > "$BIN_DIR/hoy" <<EOF
#!/usr/bin/env bash
# Installed by scripts/local-install.sh (HOY-207).
export GDK_BACKEND=x11
# webkit2gtk's DMABUF renderer fails on this GPU ("Failed to create GBM
# buffer"), leaving the webview black; fall back to shared-memory rendering.
export WEBKIT_DISABLE_DMABUF_RENDERER=1
exec "$APP_DIR/hoy-desktop" "\$@"
EOF
chmod 755 "$BIN_DIR/hoy"

cat > "$DESKTOP_DIR/hoy-desktop.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Hoy Desktop
Comment=Desktop GUI for the Pi coding agent
Exec=$BIN_DIR/hoy
Icon=hoy-desktop
Terminal=false
Categories=Development;
EOF

command -v update-desktop-database >/dev/null && update-desktop-database "$DESKTOP_DIR" || true

echo
echo "done. installed:"
echo "  app:      $APP_DIR/hoy-desktop"
echo "  sidecar:  $APP_DIR/hoy-pi"
echo "  launcher: $BIN_DIR/hoy"
echo "  desktop:  $DESKTOP_DIR/hoy-desktop.desktop"
echo "launch with: hoy"
