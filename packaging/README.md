# Distributing Hoy on Linux

How Hoy reaches Linux machines. Tauri's release build already emits `.AppImage`,
`.deb`, and `.rpm` (see `.github/workflows/release.yml`), which the site offers as
direct downloads. This directory adds the **Arch channel** on top of that.

## Arch: signed pacman repo

The Arch channel is a repository **we host and sign** at `pkgs.hoy.chat`, not the
AUR. Users add one line to `pacman.conf`, trust our key once, and then
`pacman -S hoy-desktop` (and `-Syu` upgrades) work like any native package, signed
end to end. It reuses the exact release `.deb` bytes, so there is no second build
to trust.

Everything for it lives in `pacman-repo/` (build + publish scripts, the signing
key, the `hoy-keyring` package, and full user + maintainer docs). It is live;
`.github/workflows/arch-repo.yml` republishes it on every release.

See **`pacman-repo/README.md`**.

## Not the AUR

The AUR is convenient but not a channel we control. In June 2026 the "Atomic Arch"
supply-chain attack hijacked ~1,500 orphaned AUR packages through the
package-adoption mechanism and shipped credential-stealing malware; Arch locked
down new AUR signups during the cleanup. A package there inherits that trust
model, so we ship through our own signed repo instead.

## Not Flatpak

Considered and dropped. Hoy is a coding agent: the `pi` sidecar edits the user's
files and runs their toolchain (git, node, cargo, shells). Flatpak's sandbox
blocks exactly that, so a usable build would need `--filesystem=host`,
`--share=network`, and a `flatpak-spawn --host` integration to reach the real
toolchain, at which point the sandbox is mostly gone. Not worth the work and
review for a channel whose main benefit (sandboxing) we'd have to disable. The
signed pacman repo is the Linux story beyond the direct `.deb`/`.rpm`/`.AppImage`.
