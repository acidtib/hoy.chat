# Releasing Hoy Desktop

Releases are built and published by `.github/workflows/release.yml`, which runs
on any pushed `v*` tag and builds installers for macOS (Apple Silicon + Intel),
Windows, and Linux. With updater signing configured it also publishes the signed
updater artifacts (`*.sig`) and `latest.json` that the in-app updater (HOY-187)
reads.

## One-time setup

### 1. Generate the updater signing key

The updater verifies each update with a minisign keypair (separate from OS code
signing, which is not configured yet).

```
bun tauri signer generate -w ~/.tauri/hoy.key
```

Keep the private key file and the password you set. The command prints the
public key.

### 2. Add the public key to the config

Paste the public key into `src-tauri/tauri.conf.json` at
`plugins.updater.pubkey`. Commit it (the public key is not a secret).

### 3. Set the updater endpoint

In the same `plugins.updater.endpoints` entry, replace `<owner>/<repo>` with the
real GitHub repository, e.g.
`https://github.com/acidtib/hoy/releases/latest/download/latest.json`.

### 4. Add the GitHub repo secrets

In the repository settings (Settings -> Secrets and variables -> Actions):

- `TAURI_SIGNING_PRIVATE_KEY` - the contents of `~/.tauri/hoy.key`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` - the password you chose

Without these the release still builds installers, but produces no signed
updater artifacts, so the in-app updater will not detect the release.

## Cutting a release

```
scripts/set-version.sh x.y.z        # syncs root, desktop, site, Tauri, Cargo, and lockfiles
git commit -am "vx.y.z"
git tag vx.y.z
git push origin main --tags
```

The workflow creates a draft GitHub release with the installers attached. Review
it, then publish. Once published, the `latest.json` at the endpoint points at the
new version and clients pick it up on their next update check.

## Notes

- Installers are not OS-signed (no Apple notarization or Windows certificate), so
  users see a Gatekeeper / SmartScreen warning on first launch. That is separate
  from the updater signature, which is always applied.
- The dev (`hoyd`) namespace never checks for updates; the check runs in release
  builds only.
