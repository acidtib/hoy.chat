# CI/CD

All workflows live in `.github/workflows/`. Releases are covered in
[RELEASING.md](RELEASING.md).

| Workflow | Runs on | What it does |
|---|---|---|
| `ci.yml` | every PR and push to `main` | `check`: typecheck, cargo check, clippy, fmt, oxlint, desktop tests, sidecar tests, Rust tests, and the compiled-sidecar smoke test. `site`: site lint and build. `workflows`: zizmor audit of all workflows. |
| `pr-title.yml` | every PR | `conventional-title`: runs `scripts/check-pr-title.mjs` on the PR title (types from `release-please-config.json`, scopes from AGENTS.md). Same as `bun run check:pr-title '<title>'`. |
| `build-check.yml` | PRs touching `src-tauri`, `packages/sidecar`, `scripts`, `bun.lock`, or the build workflows; weekly; manual | Full unsigned builds on all six release platforms via `build.yml`, each native build running the smoke test. Not required (path-filtered). |
| `build.yml` | called by `release.yml` and `build-check.yml` | The single platform matrix: macOS arm64/x64, Linux x64/arm64, Windows x64/arm64. Uploads into a release only when given a `release-id`. |
| `release.yml` | push to `main`; manual (rebuild a tag) | Release Please, draft release build, provenance attestation, publish. |
| `arch-repo.yml` | release published; manual | Rebuilds the signed `[hoy]` pacman repo. |
| `site-deploy.yml` | release published; site changes on `main` | Triggers the Cloudflare Pages rebuild. |
| `pi-drift.yml` | weekly; manual | Keeps one `pi-drift` issue open while npm has a newer Pi than the pin. |

`.github/dependabot.yml` opens weekly grouped updates for GitHub Actions, Cargo,
and both bun lockfiles (root workspace and `packages/sidecar/pi-src`), with a
cooldown before adopting new versions. Pi and its typebox are excluded.

## Required checks

`main` is protected by the ruleset in `.github/rulesets/main.json`: squash
merges only, no force-push or deletion, and `check`, `site`, `workflows`, and
`conventional-title` must pass. Repository admins can bypass only through a PR.
After editing the file, apply it with:

```
gh api -X PUT repos/acidtib/hoy.chat/rulesets/<id> --input .github/rulesets/main.json
```

(`gh api repos/acidtib/hoy.chat/rulesets` lists the id; use `-X POST
repos/acidtib/hoy.chat/rulesets` to create it on a fresh repo.) Renaming a
required job means updating the ruleset in the same change, or every PR blocks.

## Compiled-sidecar smoke test

`packages/sidecar/pi-src/smoke/smoke-test.ts` drives the bun-compiled binary the
way the app does: RPC JSONL over stdio against a local mock OpenAI-compatible
model, a stdio MCP echo server, one turn through `tool_search` and an approved
`mcp__echo__echo` call, a second turn with codemode on where a script makes
that call, then the start of an OAuth login. It catches what only breaks inside
the compiled binary (OAuth flow loaders, Pi's MCP wiring, codemode's worker and
QuickJS wasm, a stale binary). Run it locally after `bun run sidecar:build`:

```
bun packages/sidecar/pi-src/smoke/smoke-test.ts packages/sidecar/hoy-pi-<triple>
```

## Workflow conventions

- Every action is pinned to a full commit SHA with the version in a comment;
  Dependabot proposes the bumps. Never reference an action by tag or branch.
- Each workflow sets `permissions` explicitly, at the narrowest scope that works.
- `actions/checkout` uses `persist-credentials: false`.
- Pass `${{ }}` values into `run:` scripts through `env:`, never inline, so a
  crafted input cannot inject shell.
- zizmor (`workflows` job) enforces most of this. Run it locally with
  `GH_TOKEN=$(gh auth token) uvx zizmor .github/workflows/`.
