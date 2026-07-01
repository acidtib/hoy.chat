# Shipping Hoy for Arch Linux (AUR)

Arch users expect `yay -S hoy-desktop-bin`, not a `.deb`, `.rpm`, or `.AppImage`.
Tauri v2 has no `pacman` bundler, so the CI release does not produce an Arch
package. Instead we publish to the [AUR](https://aur.archlinux.org).

## What ships

`hoy-desktop-bin` is a **binary package**: its `PKGBUILD` downloads the official
`Hoy.Desktop_<ver>_amd64.deb` release asset and unpacks it into a pacman package.
The `.deb` already lays out `/usr/bin/hoy-desktop`, the `/usr/bin/pi` sidecar,
resources under `/usr/lib/Hoy Desktop/`, the `.desktop` entry, and hicolor icons,
so there is nothing to build. The Debian runtime deps (`libwebkit2gtk-4.1-0`,
`libgtk-3-0`) map to Arch's `webkit2gtk-4.1` and `gtk3`.

Files here:

- `hoy-desktop-bin/PKGBUILD` — the package definition.
- `hoy-desktop-bin/.SRCINFO` — generated metadata the AUR requires.
- `hoy-desktop-bin/update.sh` — bump to a new release (pkgver + sha256 + .SRCINFO).

This directory is the source of truth; the AUR git repo is a mirror of the
`hoy-desktop-bin/` contents.

## Prerequisites (one time)

1. The GitHub repo and its releases must be **public** (release assets are fetched
   anonymously by `makepkg` and by everyone who installs). Until then the download
   404s and the package cannot be built by users.
2. An AUR account with your SSH public key added (Account -> My Account -> SSH key).

## First publish

```sh
# Clone the (empty) AUR repo for the new package name.
git clone ssh://aur@aur.archlinux.org/hoy-desktop-bin.git aur-hoy-desktop-bin
cp packaging/aur/hoy-desktop-bin/{PKGBUILD,.SRCINFO} aur-hoy-desktop-bin/
cd aur-hoy-desktop-bin

# Sanity check the build (downloads the .deb, unpacks, packages).
makepkg -f
# Optional lint:
namcap PKGBUILD ./*.pkg.tar.zst

git add PKGBUILD .SRCINFO
git commit -m "Initial import: hoy-desktop-bin 0.1.1"
git push
```

Installed by users with `yay -S hoy-desktop-bin` (or paru, or manual `makepkg -si`).

## On every release

From an Arch box, after the GitHub release is published:

```sh
cd packaging/aur/hoy-desktop-bin
./update.sh 0.1.2            # sets pkgver, resets pkgrel, refreshes sha256 + .SRCINFO
git -C ../../.. add packaging/aur/hoy-desktop-bin   # commit the repo copy

# Mirror into the AUR clone and push.
cp PKGBUILD .SRCINFO /path/to/aur-hoy-desktop-bin/
cd /path/to/aur-hoy-desktop-bin
git commit -am "hoy-desktop-bin 0.1.2" && git push
```

Bump `pkgrel` (not `pkgver`) if only the packaging changes for the same upstream
version.

## Once published: point users to it

Add an Arch line to the site's Linux download block (`apps/site` InstallPanel),
e.g. `yay -S hoy-desktop-bin`, so the landing page sends Arch users to the AUR
instead of the raw `.AppImage`.

## Later: automate on release

A GitHub Actions job can push to the AUR on each `v*` tag using
[`KSXGitHub/github-actions-deploy-aur`](https://github.com/KSXGitHub/github-actions-deploy-aur)
with an AUR SSH private key stored as a repo secret. Deferred until the first
manual publish is proven.

## Known caveats

- **Anonymous download requires a public repo** (see prerequisites).
- **`x86_64` only.** There is no Linux aarch64 release build, so the package is
  `arch=('x86_64')`.
- **`/usr/bin/pi` is a generic name.** The sidecar ships as `/usr/bin/pi`, which can
  file-conflict with another package that owns `/usr/bin/pi`. The clean fix is
  upstream: rename the Tauri `externalBin` to something namespaced (e.g. `hoy-pi`)
  or relocate it under `/usr/lib`. Track separately.
- **Unsigned, like all our builds pre-1.0.** The AUR package inherits that; users
  trust the PKGBUILD + our release assets.
