# Releasing Hoy Desktop

Releases are driven by [Release Please](https://github.com/googleapis/release-please)
from Conventional Commits on `main`. Nobody edits version numbers or pushes tags
by hand. The rest of the pipeline is in [CI.md](CI.md).

## Flow

1. PRs are squash-merged; the PR title becomes the commit on `main`. Titles must
   be Conventional Commits (`.github/workflows/pr-title.yml` enforces it):
   - `feat(HOY-312): limit thinking levels per model` -> "Features"
   - `fix(HOY-333): respect autonomous mode for MCP tools` -> "Bug Fixes"
   - `feat!: ...` or a `BREAKING CHANGE:` footer -> breaking
   - `perf`, `deps`, `revert` are listed in the changelog; `docs`, `refactor`,
     `test`, `build`, `ci`, `chore`, `style` are hidden and do not trigger a
     release on their own.
   - While the version is `0.x` (`bump-patch-for-minor-pre-major` and
     `bump-minor-pre-major` in `release-please-config.json`), `feat` and `fix`
     bump the patch and a breaking change bumps the minor, so releases continue
     as `0.1.x`. From `1.0.0` on: `fix` -> patch, `feat` -> minor, breaking ->
     major. Use a `Release-As` footer to move to `0.2.0` or `1.0.0`.
2. Each push to `main` runs `.github/workflows/release.yml`. Release Please opens
   or updates a PR titled `chore: release X.Y.Z` that bumps every version field
   and prepends to `CHANGELOG.md`:
   - `package.json` (root)
   - `apps/desktop/package.json` and `apps/site/package.json`
   - `apps/desktop/src-tauri/tauri.conf.json`
   - `apps/desktop/src-tauri/Cargo.toml` and the `hoy-desktop` entry in `Cargo.lock`
3. Merging the release PR tags the commit `vX.Y.Z` and creates a **draft** GitHub
   release whose body is the changelog. The same workflow then:
   - builds through `build.yml` on macOS (arm64, x64), Linux (x64, arm64), and
     Windows (x64, arm64), smoke-testing each native sidecar, and uploads the
     installers plus the signed updater manifest into that draft;
   - checks that `latest.json` has a signed entry for all six platforms;
   - attests build provenance for every asset in the draft (verify a download
     with `gh attestation verify <file> -R acidtib/hoy.chat`);
   - publishes the release, which makes it visible to the in-app updater and
     starts `arch-repo.yml` and `site-deploy.yml`.

If a build fails, the release stays a draft and the updater never sees it. Fix
the cause on `main` if needed, then rerun the failed jobs, or run the **Release**
workflow manually with the tag (`workflow_dispatch`) to rebuild and publish an
existing release.

To force a specific version, add a `Release-As: 0.2.0` footer to a commit on
`main`. Squash merges use the PR title as the commit message, so footers
(`Release-As`, `BREAKING CHANGE`) must be typed into the commit description in
the merge dialog; a `!` in the title (`feat!:`) needs no footer.

`apps/site/package.json` is bumped too, matching the old `set-version.sh`. The
site itself reads the root `package.json`. `bun.lock` records workspace versions,
but bun does not rewrite them on a version-only change, so a stale value there is
expected and harmless.

## One-time setup

### 1. Repository settings

- Settings > General > Pull Requests: allow **squash merging** only, with the
  default commit message set to **Pull request title**. Disable merge commits and
  rebase merging so every commit on `main` is a Conventional title.
- Settings > Actions > General > Workflow permissions: leave the default
  read-only `GITHUB_TOKEN`. The workflows request what they need per job.

### 2. GitHub App for Release Please

Events created with the built-in `GITHUB_TOKEN` never start other workflows. A
release PR opened with it gets no CI run, and a release published with it never
starts `arch-repo.yml`. A GitHub App token does not have that limit, and unlike
a personal access token it is not tied to a person and expires after an hour.

1. Go to **Settings > Developer settings > GitHub Apps > New GitHub App** on the
   account that owns the repo (for an organization: Organization settings >
   Developer settings > GitHub Apps).
2. Fill in:
   - **Name**: something unique, e.g. `hoy-release-bot`. Its commits and PRs show
     up as `<name>[bot]`.
   - **Homepage URL**: the repo URL.
   - **Webhook**: uncheck **Active** (the app only mints tokens).
3. **Repository permissions**:
   - **Contents**: Read and write (release commits, tags, releases)
   - **Pull requests**: Read and write (the release PR)
   - **Issues**: Read and write (Release Please labels its PRs through the issues API)
   - **Metadata**: Read-only (required, set automatically)

   Leave everything else at **No access**, including Workflows: release commits
   never touch `.github/workflows`.
4. **Where can this GitHub App be installed?**: Only on this account.
5. Create the app. On its page:
   - copy the **Client ID** (starts with `Iv`);
   - under **Private keys**, click **Generate a private key** and keep the
     downloaded `.pem` file.
6. **Install App** (left sidebar) > install on the account > **Only select
   repositories** > `hoy.chat`.
7. In the repo, **Settings > Secrets and variables > Actions**:
   - **Variables** tab: `RELEASE_APP_CLIENT_ID` = the Client ID
   - **Secrets** tab: `RELEASE_APP_PRIVATE_KEY` = the full contents of the `.pem`
     file, including the `BEGIN`/`END` lines

   Then delete the local `.pem` file.

### 3. Updater signing (HOY-187)

#### Generate the updater signing key (already done)

The updater verifies each update with a minisign keypair (separate from OS code
signing, which is not configured yet).

```
bun tauri signer generate -w ~/.tauri/hoy.key
```

Keep the private key file and the password you set. The command prints the
public key.

#### Public key and endpoint

The public key lives in `apps/desktop/src-tauri/tauri.conf.json` at
`plugins.updater.pubkey` (not a secret), and `plugins.updater.endpoints` points
at `https://github.com/acidtib/hoy.chat/releases/latest/download/latest.json`.

#### Repo secrets

In Settings > Secrets and variables > Actions:

- `TAURI_SIGNING_PRIVATE_KEY` - the contents of `~/.tauri/hoy.key`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` - the password you chose

Without these, release builds fail: Tauri refuses to bundle updater artifacts
without the private key ("A public key has been found, but no private key").
PR builds pass `--no-sign` for that reason.

### 4. Other workflows

`arch-repo.yml` needs its own GPG and R2 secrets (listed at the top of that
file) and does nothing until they exist. `site-deploy.yml` rebuilds hoy.chat when
a release is published; the site reads its version from the root `package.json`
and, in CI, refuses to build when that differs from the latest published release.

## First release under Release Please

The commits on `main` since `v0.1.8` predate Conventional Commits, so Release
Please ignores them (`bootstrap-sha` in `release-please-config.json` stops its
scan at `v0.1.8`). The first release PR appears with the first `feat`/`fix`
merged after this setup. To include the earlier work, squash-merge pending
branches with Conventional titles, or push a commit with a `Release-As: 0.1.9`
footer.

## Notes

- Installers are not OS-signed (no Apple notarization or Windows certificate), so
  users see a Gatekeeper / SmartScreen warning on first launch. That is separate
  from the updater signature, which is always applied.
- The dev (`hoyd`) namespace never checks for updates; the check runs in release
  builds only.
