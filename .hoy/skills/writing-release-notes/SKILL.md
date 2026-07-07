---
name: writing-release-notes
description: Use when cutting, drafting, editing, or publishing a Hoy release (a vX.Y.Z tag / GitHub Release), or writing its changelog entry. Covers release notes voice, what to include, and publishing so hoy.chat picks it up.
user-invocable: true
argument-hint: "[version, e.g. 0.2.0]"
---

# Writing release notes for Hoy

## The one fact that shapes everything

A release's markdown body renders in **two places**: the GitHub Release page AND `hoy.chat/changelog` (fetched from GitHub Releases at build time by `apps/site/lib/releases.ts`). Write the body for the changelog reader. GitHub adds the asset list and title on its own.

## Workflow

1. **Find what shipped.** `git log <prev-tag>..HEAD --oneline` and skim the diff. Group by user-facing outcome, not by commit.
2. **Draft the body** in the shape below, to a file (e.g. scratchpad `vX.Y.Z-notes.md`).
3. **Publish.** CI (`release.yml`) auto-creates a *draft* release named `Hoy Desktop vX.Y.Z` with a placeholder body on tag push. Replace it and undraft:
   ```
   gh release edit vX.Y.Z --repo acidtib/hoy.chat --notes-file <file> --draft=false
   ```
   Add `--prerelease` for a pre-1.0 preview build (the changelog tags it amber).
4. **Verify:** `gh release view vX.Y.Z --repo acidtib/hoy.chat --json body -q .body`, then confirm the entry at `hoy.chat/changelog#X.Y.Z`. Publishing pings the Cloudflare deploy hook (`site-deploy.yml`); the site rebuilds and picks it up.

Keep the release **title** as `Hoy Desktop vX.Y.Z` — the changelog uses it as the entry heading.

## Body shape (this is the whole recipe)

```markdown
<One sentence: the headline of this release, in plain terms.>

## What's in it        (feature release)   — or —   ## What changed  (incremental)

- **Short bold label.** One or two sentences on the user-facing outcome.
- ...

### Fixed              (only if there are fixes worth naming)
- ...
```

Rules for the body:
- **Only what changed in THIS release.** Standing facts that are true every release, install steps, system requirements, beta status, bring-your-own-key, "unsigned build" caveats, do NOT belong in the body. The site's landing page already carries them and GitHub auto-lists the assets. (v0.1.1 included Install / Known rough edges because it was the first build; do not carry that forward.)
- Lead each bullet with the outcome a user notices, then the detail.
- Group by theme. A wall of raw commit subjects is not release notes.

## Voice

Honest, calm, capable; energetic without hype. Same register as the landing copy. See `apps/site/PRODUCT.md`.

**Hard no's:**
- **Never call Hoy "native."** It is a real desktop app built on Tauri + a webview. Say "a real desktop app," never "native."
- No hype: no "revolutionary," "seamless," "blazing-fast," no fake urgency, no inflated claims. State what it does.
- Project-wide: **no emojis, no em-dashes** (use a comma or semicolon).

**House terms (use exactly):**
- "mid-conversation," never "mid-session."
- Model providers: "any provider your agent supports" (or name a broad set), never a hardcoded short list, Hoy supports every provider Pi does.
- Hoy is the product; Pi is the engine it drives. Fine to write "Hoy drives the Pi agent"; do not headline Pi.

## Common mistakes (seen in practice)

| Mistake | Fix |
|---|---|
| Calling the app "native" | "a real desktop app" (Tauri + webview) |
| Padding the body with Install / beta / BYOK boilerplate | Cut it; the site and GitHub assets cover it. Body = changes only. |
| "mid-session" | "mid-conversation" |
| Naming only 3-4 providers | "any provider your agent supports" |
| Dumping commit subjects as bullets | Rewrite as user-facing outcomes, grouped by theme |
| Leaving the CI placeholder body ("See the assets...") | Always replace before undrafting |
