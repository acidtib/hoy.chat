# design-sync notes — hoy-desktop

## Repo shape
This repo is the Hoy Desktop Tauri app itself, not a standalone published
design-system package. There is no library build (package.json has no
main/module/exports, `private: true`), no Storybook. Synced in `package`
shape with a synthesized entry from `src/components/ui` (componentSrcMap
pins exact component names to files, so the synth auto-derivation scan
never runs — the 23-component scope is exact, not heuristic).

`src/components/ai-elements/*` is bundled via `cfg.extraEntries` (one path
per file) rather than `srcDir`, so the blanket synth entry never pulls in
`src/components/settings/*` (which depends on zustand state and Tauri
`invoke()` calls and would either collide on export names or throw at
module-eval time inside the IIFE bundle). Deliberately out of scope for
this sync — settings panels are app screens, not reusable DS components.

Each compound component (Dialog, Select, Command, AlertDialog, etc.)
syncs as ONE component named after its root export (e.g. `Dialog`), not
one per sub-part (`DialogTrigger`, `DialogContent`, ...). Sub-parts are
documented through the composition shown in the authored preview's JSX,
not as separate cards/type contracts. This is a deliberate scope choice,
not a converter default — revisit if the design agent in practice needs
typed contracts for the sub-parts.

## Styling
Tailwind v4, `src/index.css` is the single entry: imports `tailwindcss`,
`tw-animate-css`, `shadcn/tailwind.css` (the radix-nova shadcn preset),
and `@fontsource-variable/geist`. Uses `@theme inline` token mapping —
CSS custom properties (`--background`, `--primary`, etc.) are the real
vocabulary, not bespoke utility classes.

## CSS / fonts
`cssEntry` points at the Vite-compiled stylesheet (`dist/assets/index-<hash>.css`,
built via `buildCmd: bun run build`), not the Tailwind v4 source
(`src/index.css`) — the source file's `@import "tailwindcss"` /
`@import "tw-animate-css"` / etc. are bare npm specifiers that Tailwind's
build resolves, not literal CSS `@import`s a browser or this converter can
follow; pointing cssEntry at it produces `[CSS_IMPORT_MISSING]`. On
resync: rerun `bun run build`, and if the CSS content changed its output
hash changes too — update `cssEntry` to match the new `dist/assets/index-*.css`
filename.

The compiled CSS's own `@font-face` rules use Vite-rewritten root-absolute
URLs (`/assets/geist-*.woff2`) that don't resolve under the repo — the
build correctly drops them (`dead @font-face block(s) dropped`) and instead
sources the real files via `cfg.extraFonts` pointed at
`node_modules/@fontsource-variable/geist/index.css` (relative `url()`s,
resolves cleanly).

"Geist Mono" and "JetBrains Mono" appear only as `--font-mono` fallback
entries in the token CSS — this app never ships those font files (relies
on whatever's installed on the user's OS, final fallback is generic
`monospace`). Confirmed with the user (2026-06-30): accept as-is, system
font substitute in synced previews, not a gap design-sync should try to
fix.

## Prop extraction (.d.ts)
This app's shadcn/ai-elements components don't ship a real `.d.ts` tree (no
publish build), and most shadcn components use inline destructured param
types rather than a named `<Name>Props` export — design-sync's prop
extractor needs one or the other, so without help every component
collapsed to a useless `[key: string]: unknown`. Fixed via:

1. `package.json` gained a `"types": "dist/types/index.d.ts"` field
   (additive, harmless — the target only exists after running
   `buildCmd`, and `dist/` is gitignored). This is what makes
   design-sync's fallback "read the component's own call signature from
   the package entry" path work for components without a named Props type.
2. `buildCmd` runs `tsc -p .design-sync/dts.tsconfig.json` (committed,
   durable — NOT under `.ds-sync/`, which gets blown away and
   re-staged from the skill on every sync) to emit real declarations for
   `src/components/ui/**` and `src/components/ai-elements/**` into
   `dist/types/`.
3. `.design-sync/fix-dts-aliases.mjs` rewrites `@/...` path-alias
   imports inside the generated `.d.ts` files to relative paths (`tsc`'s
   declaration emitter preserves import specifiers as-written — it does
   not resolve `tsconfig.json`'s `paths`; design-sync's own ts-morph
   prop-extraction project (`lib/dts.mjs`) has no baseUrl/paths config
   either, so an unrewritten `@/components/ui/dialog` import resolves to
   nothing there — this silently empties the importing component's prop
   list; hit `ModelSelector`, `Reasoning`, `Tool`, all of which reference
   another synced component's type via `ComponentProps<typeof X>`), then
   regenerates `dist/types/index.d.ts` (the barrel `pj.types` points at)
   from whatever `.d.ts` files actually exist under `components/` — stays
   in sync with `componentSrcMap` automatically, nothing to hand-maintain.

Verified after all three: zero components fall back to
`[key: string]: unknown` (was all 24, before the `types` field; was
3 after the `types` field but before the alias rewrite).

## EXPORT_COLLISION (benign)
Build prints `[EXPORT_COLLISION]` for all 7 ai-elements components
(CodeBlock, Conversation, Message, ModelSelector, Reasoning, Shimmer,
Tool) claiming the "main package" already exports those names. False
positive: `componentSrcMap` pins all 24 component names (including the
ai-elements ones) into the `components` metadata list, and because the
main entry is synth-derived (`src.synthEntry`), the build's export-collision
gate treats every name in that metadata list as if the main `srcDir`-scoped
entry (`src/components/ui` only) exports it — it doesn't; ai-elements is
bundled separately via `extraEntries`. Verified the actual bundle: no real
runtime collision, `window.HoyUI.CodeBlock` etc. resolve to the
ai-elements binding correctly. Safe to ignore; re-check after any
componentSrcMap/extraEntries restructure that this reasoning still holds.

## Verification (no Playwright)
User declined the local Playwright/Chromium install (2026-06-30) to avoid
the ~200MB download — `package-validate.mjs` ran with `--no-render-check`,
and `package-capture.mjs`'s screenshot-based absolute grading (§4.3) never
ran (it hard-requires `playwright`, same as validate; `resync.mjs --no-render-check`
still ends with `capture: {ok:false, exit:2}` and an overall `ok:false`
verdict for exactly this reason — expected, not a regression to chase).
Previews are authored from real composition (component name, JSDoc/props,
and how the component is actually used elsewhere in this app's own src/,
mined from ConfirmCloseDialog.tsx, ThreadView.tsx, ModelSelect.tsx,
ThreadHistory.tsx, settings/panels.tsx), but were **not** visually
screenshot-verified or graded — no `.cache/review/*.grade.json` files
exist, every component sits in the resync verdict's `pendingGrade`.
Structural validate is clean (bundle parses, all `.d.ts` parse, CSS/fonts
resolve, all 24 previews compiled with zero floor-card fallbacks). On a
future resync, if Playwright becomes available, run a full
`package-capture.mjs` pass once to establish the grade baseline — until
then every resync re-treats all 24 components as ungraded.

## Re-sync risks
- `componentSrcMap` is the source of truth for which 24 components sync.
  Adding a new shadcn/ai-elements component to the app requires adding it
  here explicitly — it will NOT be auto-discovered.
- `extraEntries` paths are hand-enumerated per ai-elements file; a new
  file added to that directory needs a new extraEntries entry too.
- No grading baseline exists yet (see Verification above) — re-syncs
  can't rely on "carried forward" grade skips until a Playwright-backed
  capture run happens at least once.
- `cssEntry`'s hash-named filename can go stale after a rebuild that
  changes CSS content (see CSS / fonts above).
- `dist/types` (and `dist/` generally) occasionally got wiped mid-session
  by something outside our own commands (observed during this sync,
  cause not identified — possibly an editor/LSP-triggered typecheck or
  background process). Harmless since `buildCmd` regenerates it
  deterministically (same content hash), but if a build step ever finds
  `dist/types` missing right after it was generated, just rerun `buildCmd`
  rather than assuming corruption.
- `styles.css` ships only the Tailwind utility classes this app's own
  source currently uses (content-scanned, not a live compiler) — some
  CSS custom-property tokens exist (`--card`, `--ring`, `--accent-foreground`,
  `--brand-foreground`) with no matching compiled utility class
  (`bg-card`, `ring-ring`, etc.) because nothing in the app uses that
  exact class yet. `.design-sync/conventions.md`'s token table only lists
  utilities verified present in the compiled CSS, and tells the design
  agent to fall back to `style={{ ... : "var(--token)" }}` for the rest.
  If the app starts using one of those utilities, re-verify the table
  (`grep -E '\.<class>([,{:]|$)' ds-bundle/_ds_bundle.css`) and promote it
  from the fallback note into the table.
