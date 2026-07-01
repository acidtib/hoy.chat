#!/usr/bin/env bash
# Bump the AUR -bin package to a new release: sets pkgver, resets pkgrel, pulls the
# released .deb's sha256, and regenerates .SRCINFO. Run from an Arch box (needs
# makepkg). Usage: ./update.sh 0.1.2
set -euo pipefail

ver="${1:?usage: ./update.sh <version, e.g. 0.1.2>}"
ver="${ver#v}"
cd "$(dirname "$0")"

url="https://github.com/acidtib/hoy.chat/releases/download/v${ver}/Hoy.Desktop_${ver}_amd64.deb"
echo "Fetching ${url}"
sum="$(curl -fsSL "$url" | sha256sum | awk '{print $1}')"
echo "sha256 = ${sum}"

sed -i \
  -e "s/^pkgver=.*/pkgver=${ver}/" \
  -e "s/^pkgrel=.*/pkgrel=1/" \
  -e "s/^sha256sums=.*/sha256sums=('${sum}')/" \
  PKGBUILD

makepkg --printsrcinfo > .SRCINFO
echo "Updated PKGBUILD + .SRCINFO to ${ver}. Review, commit, and push to the AUR."
