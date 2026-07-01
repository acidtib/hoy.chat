#!/usr/bin/env bash
# Build a signed pacman repo from a release .deb, ready to upload to static
# hosting. Reuses the exact bytes we already ship: repacks the .deb into a
# .pkg.tar.zst, signs it and the repo DB, and drops everything in an output dir.
#
# Run on an Arch box (needs makepkg, repo-add, gpg). The signing key must exist in
# the invoking user's gpg keyring.
#
# Usage:
#   ./build-repo.sh --version 0.1.2 --deb ./Hoy.Desktop_0.1.2_amd64.deb \
#                   --key <GPG_KEY_ID> --out ./out
#
# Then sync ./out to the repo host, e.g. pkgs.hoy.chat/arch/x86_64/
set -euo pipefail

REPO_NAME="hoy"
version="" deb="" key="" out="./out"
while [ $# -gt 0 ]; do
  case "$1" in
    --version) version="${2#v}"; shift 2 ;;
    --deb) deb="$2"; shift 2 ;;
    --key) key="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
: "${version:?--version required}"
: "${deb:?--deb required (path to the release .deb)}"
[ -f "$deb" ] || { echo "deb not found: $deb" >&2; exit 1; }

sign_flags=()
repo_sign=()
if [ -n "$key" ]; then
  sign_flags=(--sign --key "$key")
  repo_sign=(--sign --key "$key")
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp "$deb" "$work/app.deb"

# A throwaway PKGBUILD that repacks the local .deb (no network, no rebuild).
cat > "$work/PKGBUILD" <<PKGBUILD
pkgname=hoy-desktop
pkgver=${version}
pkgrel=1
pkgdesc="A native desktop app for coding agents (Hoy Chat), powered by the Pi agent"
arch=('x86_64')
url="https://hoy.chat"
license=('MIT')
depends=('webkit2gtk-4.1' 'gtk3')
options=('!strip')
source=("app.deb")
noextract=("app.deb")
sha256sums=('SKIP')
package() {
  bsdtar -xOf app.deb 'data.tar*' | bsdtar -xpf - -C "\$pkgdir"
}
PKGBUILD

( cd "$work" && makepkg -f --noconfirm --nodeps "${sign_flags[@]}" )

mkdir -p "$out"
cp "$work"/hoy-desktop-*.pkg.tar.zst "$out"/
[ -n "$key" ] && cp "$work"/hoy-desktop-*.pkg.tar.zst.sig "$out"/ 2>/dev/null || true

# Also build the keyring package (arch=any) so users can trust our key with a
# `pacman -U` bootstrap and upgrade it from the repo afterwards. It rarely
# changes; rebuilding each release is cheap and keeps the repo self-contained.
here="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$here/keyring/PKGBUILD" ]; then
  cp -r "$here/keyring" "$work/keyring"
  ( cd "$work/keyring" && makepkg -f --noconfirm --nodeps "${sign_flags[@]}" )
  cp "$work"/keyring/hoy-keyring-*.pkg.tar.zst "$out"/
  [ -n "$key" ] && cp "$work"/keyring/hoy-keyring-*.pkg.tar.zst.sig "$out"/ 2>/dev/null || true
fi

# Build (or update) the repo DB in the output dir from every package present.
( cd "$out" && repo-add "${repo_sign[@]}" "${REPO_NAME}.db.tar.gz" ./*.pkg.tar.zst )

echo "Repo built in: $out"
ls -1 "$out"
echo
echo "Upload the contents of '$out' to https://pkgs.hoy.chat/arch/x86_64/"
