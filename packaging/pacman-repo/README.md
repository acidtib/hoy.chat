# Official signed pacman repo

A repository we host and sign, so Arch users install and update Hoy without the
AUR. This is the Arch channel (see `../README.md` for why not the AUR).

- Host: **`https://pkgs.hoy.chat`** (Cloudflare R2, static objects).
- Signing key: **Hoy Packages** `<packages@hoy.chat>`
  fingerprint `DC196437C706CF3B2FE583FBCEEBA907B734C05F`.
  Public key committed as `hoy-packages.pub`; private key held offline (never in
  this repo), added to CI as a secret.

## User setup (what we document on the site)

Trust our key once (fetched over HTTPS, before any signed package exists):

```sh
curl -fsSL https://pkgs.hoy.chat/hoy-packages.pub | sudo pacman-key --add -
sudo pacman-key --lsign-key DC196437C706CF3B2FE583FBCEEBA907B734C05F
```

Add the repo to `/etc/pacman.conf`:

```ini
[hoy]
Server = https://pkgs.hoy.chat/arch/$arch
```

Install and stay current:

```sh
sudo pacman -Sy hoy-desktop
sudo pacman -Syu            # future releases upgrade like any repo package
```

Optionally install `hoy-keyring` (also in the repo) so key updates/rotations flow
through `pacman -Syu`. It is not the bootstrap: a new user can't `pacman -U` a
package signed by a key they don't trust yet, which is why the key is fetched over
HTTPS above.

## Maintainer: build + publish

Run from an Arch box (needs `makepkg`, `repo-add`, `gpg`, `aws-cli`), with the
private key imported into your gpg keyring.

```sh
cd packaging/pacman-repo

# 1. Build the signed repo (app package from the release .deb, plus hoy-keyring).
./build-repo.sh --version 0.1.2 \
                --deb ./Hoy.Desktop_0.1.2_amd64.deb \
                --key DC196437C706CF3B2FE583FBCEEBA907B734C05F \
                --out ./out

# 2. Publish to R2 (needs the R2_* / AWS_* env below), including the public key.
R2_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com \
R2_BUCKET=<bucket> \
AWS_ACCESS_KEY_ID=<id> AWS_SECRET_ACCESS_KEY=<secret> \
  ./publish-r2.sh --out ./out --pubkey ./hoy-packages.pub
```

`build-repo.sh` repacks the exact release `.deb` (no rebuild), so the bytes users
get are the bytes we release. Output: signed `hoy-desktop-*.pkg.tar.zst`,
`hoy-keyring-*.pkg.tar.zst`, and the signed repo DB (`hoy.db` / `hoy.files`).

## CI

`.github/workflows/arch-repo.yml` does the above automatically when a GitHub
release is **published** (also runnable via workflow_dispatch). It builds in an
Arch container and needs these repo secrets:

| Secret | What |
| --- | --- |
| `HOY_PACKAGES_GPG_KEY` | armored private signing key (`hoy-packages.key`) |
| `R2_ENDPOINT` | `https://<accountid>.r2.cloudflarestorage.com` |
| `R2_BUCKET` | bucket mapped to `pkgs.hoy.chat` |
| `R2_ACCESS_KEY_ID` | R2 API token access key id |
| `R2_SECRET_ACCESS_KEY` | R2 API token secret |

## Cloudflare R2 setup (done, recorded for reference)

The repo is live at `pkgs.hoy.chat`. For a rebuild-from-scratch:

1. Create an R2 bucket (`hoy-pkgs`).
2. Connect a custom domain `pkgs.hoy.chat` to the bucket (R2 -> Settings -> Public
   access -> Custom Domain). This serves objects over HTTPS at that host.
3. Create an R2 API token (Object Read & Write) scoped to the bucket; put its
   endpoint/keys in the CI secrets above.
4. **Disable Browser Integrity Check for the hostname.** Cloudflare's BIC returns
   HTTP 403 / error 1010 to some CLI user agents. Add a Configuration Rule
   (`hoy.chat` zone -> Rules -> Configuration Rules) matching
   `(http.host eq "pkgs.hoy.chat")` that turns **Browser Integrity Check** off, so
   `pacman` / `curl` / `wget` are never challenged. Also confirm Bot Fight Mode
   isn't blocking them.
5. First publish seeds `hoy-packages.pub` at the root and the repo under
   `arch/x86_64/`.

## Notes

- `x86_64` only (no Linux aarch64 release build yet).
- The signing key is passphraseless for unattended CI signing; its secrecy rests
  on the private-key file and the CI secret. Rotate by generating a new key,
  bumping `hoy-keyring`, and re-publishing.
- The sidecar installs as `/usr/bin/hoy-pi` (namespaced under HOY-230). It used to
  ship as the generic `/usr/bin/pi`, which risked a file conflict with any other
  package owning that path; the `externalBin` rename removed that risk.
