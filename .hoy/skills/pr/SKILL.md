---
name: pr
description: Open a pull request for the current branch with a clear title and description. Use when asked to open, raise, or prepare a PR.
user-invocable: true
argument-hint: "[base branch]"
---

# Pull request

Open a pull request for the current branch against its base (default: the repo's main branch).

## Workflow

1. **Prepare the branch.** `git status --short` must be clean; commit or stash first (use the commit skill when the change is uncommitted). `git log <base>..HEAD --oneline` to confirm the branch holds one logical change. Sync with the base when behind.
2. **Verify.** Run the project's checks (tests, typecheck, lint) before opening. A red PR wastes the reviewer's round trip.
3. **Title.** Conventional Commits, same as a commit message: `type(scope): lowercase description`. The title becomes the squash-merge commit and the changelog line on release-please repos, so keep it user-facing. Validate with the repo's title checker when one exists.
4. **Description.** A few lines: what changed and why, how it was verified (commands and result), anything the reviewer must look at. Reference the tracking issue (`Refs HOY-123` style) so it links. No file-by-file narration, no tool attribution.
5. **Open, then report.** Create the PR and report the URL plus a one-line summary. Do not merge it unless asked; merging policy belongs to the repo, not this skill.

## Rules

- One PR, one change. A mixed branch gets split before opening, not explained after.
- Never push to the base branch directly. Never merge your own PR without an explicit instruction.
