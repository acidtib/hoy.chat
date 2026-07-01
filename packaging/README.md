# Distributing Hoy on Linux

How we get Hoy onto Linux machines, and why. Tauri already emits `.AppImage`,
`.deb`, and `.rpm` (see `.github/workflows/release.yml`). This directory covers
the Arch and sandboxed-app stories on top of that.

## Why not lead with the AUR

The AUR is convenient but not a channel we control. In June 2026 the "Atomic Arch"
supply-chain attack hijacked ~1,500 orphaned AUR packages through the
package-adoption mechanism and shipped credential-stealing malware; Arch locked
down new AUR signups during the cleanup. The AUR still works, but a package there
inherits that trust model, so we do not ship through it. We use channels where
**we sign the bytes**:

1. **Our own signed pacman repo** (primary for Arch). One line in `pacman.conf`,
   packages signed with our key. Immune to the AUR takeover class of attack.
2. **Flathub** (secondary, with real caveats, see below).

## Option 1: signed pacman repo  (recommended for Arch)

We host a repository users add once:

```ini
# /etc/pacman.conf
[hoy]
Server = https://pkgs.hoy.chat/arch/$arch
```

They import our package-signing key once (or install a `hoy-keyring` package), then
`pacman -S hoy-desktop` and future `-Syu` upgrades Just Work, signed end to end.

Build side (`pacman-repo/build-repo.sh`): take the release `.deb` we already build,
repack it into a `.pkg.tar.zst`, sign it and the repo DB with our GPG key, and
publish the repo files to the host. This reuses the exact release bytes, so there
is no second build to trust.

Open decisions before this ships:
- **Where to host** the repo files (Cloudflare R2 / Pages under `pkgs.hoy.chat`,
  GitHub Releases, or S3). Static file hosting is all pacman needs.
- **A dedicated package-signing GPG key** (not a personal key), published so users
  can verify it, ideally shipped as a `hoy-keyring` package so `SigLevel` can stay
  strict.

See `pacman-repo/README.md`.

## Option 2: Flathub  (secondary — read the caveat)

`flatpak/` has a ready manifest that repacks the same `.deb` into a Flatpak.
Mechanically it works. The problem is what Hoy *is*.

**Hoy is a coding agent.** The `pi` sidecar edits files across the user's projects
and runs their toolchain (git, node, cargo, compilers, shells). Flatpak's whole
point is to sandbox exactly that. To make the agent useful inside the sandbox we
would have to:

- `--share=network` (talk to model APIs) — mandatory.
- `--filesystem=host` (read/write the user's code anywhere) — mandatory for a
  coding agent, and something Flathub reviewers push back on.
- Run host tools via `flatpak-spawn --host`, which means **changing how the sidecar
  executes commands** (today it runs them directly; inside the sandbox that only
  sees the GNOME runtime, not the user's real toolchain).

At that point the sandbox is mostly punched through anyway. So Flathub is worth
offering for discoverability and for users who want it, but it is not the primary
channel and needs real work (the `flatpak-spawn` integration, an AppStream
metainfo file, a stable app id, and Flathub review). The manifest and metainfo
scaffold are checked in so we can pick it up when we decide it's worth it.

See `flatpak/README.md`.

## Summary

| Channel            | We control/sign | Fits a coding agent | Effort to ship |
| ------------------ | --------------- | ------------------- | -------------- |
| Signed pacman repo | yes             | yes                 | medium (host + key) |
| Flathub            | partial         | poorly (sandbox)    | high (spawn work + review) |

The AUR is deliberately not used, see the "Why not lead with the AUR" section.
