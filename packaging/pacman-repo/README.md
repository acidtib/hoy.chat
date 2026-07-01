# Official signed pacman repo

A repository we host and sign, so Arch users install and update Hoy without the
AUR. This is the recommended Arch channel (see `../README.md` for why).

## User side (what we document on the site)

```ini
# /etc/pacman.conf  — add at the bottom
[hoy]
Server = https://pkgs.hoy.chat/arch/$arch
```

Then, one time, trust our package-signing key:

```sh
# Option A: install our keyring package (preferred once published)
sudo pacman -U https://pkgs.hoy.chat/arch/x86_64/hoy-keyring-<ver>-any.pkg.tar.zst

# Option B: import the key directly into pacman's keyring
sudo pacman-key --recv-keys <FINGERPRINT>
sudo pacman-key --lsign-key <FINGERPRINT>
```

Install and stay current:

```sh
sudo pacman -Sy hoy-desktop
sudo pacman -Syu            # future releases upgrade like any repo package
```

## Maintainer side

`build-repo.sh` turns a release `.deb` into a signed, hostable repo. It repacks
the exact bytes we release (no rebuild), so there's nothing extra to trust.

```sh
./build-repo.sh --version 0.1.2 \
                --deb ./Hoy.Desktop_0.1.2_amd64.deb \
                --key <GPG_KEY_ID> \
                --out ./out
# sync ./out/* to https://pkgs.hoy.chat/arch/x86_64/
```

Output: `hoy-desktop-<ver>-1-x86_64.pkg.tar.zst` (+ `.sig`), and the repo DB
`hoy.db` / `hoy.files` (+ `.sig`). pacman needs nothing more than static file
hosting.

## To decide before this ships

1. **Host.** Any static host works: Cloudflare R2/Pages under `pkgs.hoy.chat`,
   GitHub Releases, or S3. Cloudflare pairs naturally with the site (HOY-224).
2. **Signing key.** Generate a dedicated package-signing GPG key (not a personal
   key). Publish its fingerprint. Ship a `hoy-keyring` package so `SigLevel` can
   stay strict without users hand-importing keys.
3. **CI.** Add a release-job step that runs `build-repo.sh` with the freshly built
   `.deb` and a key from CI secrets, then uploads `out/` to the host. Until then
   this is a manual step from an Arch box.

## Notes

- `x86_64` only (no Linux aarch64 release build yet).
- The sidecar installs as `/usr/bin/pi`, a generic name that can file-conflict with
  another package owning `/usr/bin/pi`. Worth namespacing the sidecar upstream
  (e.g. `hoy-pi`) or relocating under `/usr/lib`. Tracked separately.
