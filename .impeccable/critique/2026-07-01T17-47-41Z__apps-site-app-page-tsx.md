---
target: apps/site/app/ (landing + changelog)
total_score: 27
p0_count: 1
p1_count: 2
timestamp: 2026-07-01T17-47-41Z
slug: apps-site-app-page-tsx
---
Method: dual-agent (A: design-review · B: detector+browser-overlay)

# Critique: hoy.chat marketing site (BRAND register)

Target: `apps/site/app/` (landing + changelog). Live evidence: static export served locally, both pages screenshotted and overlay-scanned.

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|-----------|-------|-----------|
| 1 | Visibility of system status | 3 | Build-time version resolves and displays; little dynamic state on a static page. |
| 2 | Match system / real world | 3 | Dev-appropriate language; "Platform" card label is meaningless noise. |
| 3 | User control and freedom | 3 | Wordmark returns home, external links marked. |
| 4 | Consistency and standards | 2 | Header nav (`Changelog, GitHub`) vs footer (`GitHub, License, Changelog`) differ in set and order; "right-click, Open" duplicated. |
| 5 | Error prevention | 3 | Proactively warns about Gatekeeper/SmartScreen before the user hits them. |
| 6 | Recognition rather than recall | 3 | Steps visible; user must self-identify OS (no auto-detect). |
| 7 | Flexibility and efficiency | 2 | Primary CTA lands on the Releases listing, not an asset; no OS detection. |
| 8 | Aesthetic and minimalist design | 2 | Clean tokens, but 4 empty placeholder boxes + redundant eyebrows are dead weight over a third of the page. |
| 9 | Error recovery | 3 | Changelog empty state is graceful and honest. |
| 10 | Help and documentation | 3 | Clear per-platform install steps; links to GitHub. |
| **Total** | | **27/40** | **Acceptable, competent-but-unremarkable.** |

## Anti-Patterns Verdict

**Does this look AI-generated? Yes, and the tell is the four empty boxes where the product should be.**

LLM assessment: the page hits four named brand slop tells at once. (1) Eyebrow kickers above every section (`INSTALL`, `HOW IT WORKS`); "Install" sits directly over "Get running," saying it twice. (2) An identical icon-less 3-card grid, each topped by the literal word "Platform" (a kicker labeling nothing). (3) Four dashed barber-pole `.shot` placeholders standing in for product screenshots. (4) Zero real imagery on a "feels-like-the-product" section that exists to show the app. Monospace is used honestly (real commands), so it passes that one; the palette is disciplined, not timid.

Deterministic scan (`detect.mjs`, exit 2): 1 markup finding, `overused-font` (Geist) at `globals.css:34`. Browser overlay (detect.js injected on both pages, succeeded): landing 10 findings, changelog 0 ("No anti-patterns found").
- Real: 4x placeholder captions at ~4.1:1 and, corroborating the design side, `--muted-2` (#7c7c86) small text just under AA; 2x over-long line length (`beta-note` ~89ch, `callout` ~122ch).
- False positives: `overused-font`/`single-font` (Geist) is the deliberate, already-shipped brand font shared with the desktop app, identity-preservation wins; the callout contrast hits (1.0:1, 1.7:1) mis-sample the solid `--warn` as the background instead of the `--warn-bg` translucent tint, the amber text is clearly readable in the render.

Where they agree: eyebrows and placeholders (both A and B). Where the detector added value: line-length and the exact contrast ratios. Where the LLM added value: nav inconsistency, CTA-does-not-download, triplicated unsigned-build message, no POV.

## Overall Impression

The honest, candid voice is genuinely distinctive and the token discipline is real. But the layout is the modal dark dev-tool landing page, and the "How it works" section, the emotional payoff, is four empty rectangles. The biggest opportunity: replace the placeholders with a real product visual and let the honesty voice drive the composition, not just two paragraphs.

## What's Working

1. Honesty-forward copy is a real differentiator, the beta-note and unsigned-build callout state the reality plainly, which builds more trust with a skeptical pre-1.0 audience than polished claims would. Executes "honesty-is-the-pitch."
2. Disciplined token system, one violet brand accent; amber reserved consistently for beta/honesty signals (badge, changelog `tag-pre`, unsigned callout) and nowhere else.
3. Engineering-as-design robustness, version and changelog resolve from GitHub Releases at build time with a fallback and graceful empty state; the site cannot show stale or broken data.

## Priority Issues

- **[P0] Four empty screenshot placeholders on a "feels-like-the-product" page.** The "Local, and yours" section is four dashed placeholder boxes plus a `TODO(HOY-224)`. Why it matters: this is a public surface about to deploy; the page's core payoff is a void, it reads as unfinished and hands the skeptical-developer persona ammunition. Fix: ship real captures (sidebar / streaming thread / tool calls / model selector); if not ready, cut the section and deploy without it, no section beats a placeholder section. Command: `/impeccable harden` (or a dedicated capture task).
- **[P1] No POV, it collapses into the category default.** "A centered dark landing page with a violet accent, a beta pill, install cards, and placeholder screenshots" describes every dark dev tool. Restraint without intent reads as mediocre. Fix: lead with a real product visual (the streaming transcript is the hook), give the hero a product-forward/asymmetric composition, let the honesty voice drive layout. Command: `/impeccable bolder`.
- **[P1] Nav inconsistency + message redundancy.** Header nav and footer nav differ in set and order; the unsigned-build story appears 3x (beta-note, macOS card step 3, amber callout). Fix: unify nav order across header/footer; consolidate the unsigned-build message to one authoritative callout. Command: `/impeccable clarify`.
- **[P2] `--muted-2` (#7c7c86) fails WCAG AA for small text on panels (~4.4:1).** Used for the "Platform" tag, section eyebrows, placeholder captions, and changelog dates (11-13px). Fix: lighten toward ~#8b8b95 for on-panel small text, or stop using it for body-adjacent copy. Command: `/impeccable audit`.
- **[P2] Primary CTA does not deliver a download.** "Download v0.1.1" links to the Releases listing page, not an installer, with no OS detection. Fix: detect OS and link the matching asset, or relabel to "Get the latest release" so the promise matches the destination. Command: `/impeccable shape`.

## Persona Red Flags

- **Jordan (first-timer):** reads the honest pitch (good), scrolls to see the app, hits four empty boxes, concludes it may not be finished; the "Download" then doesn't hand over a file. High bounce at peak curiosity.
- **Skeptical developer evaluating a pre-1.0 tool (project-specific):** rewards the candor about unsigned builds and BYO-key, but the empty placeholders cancel the credit ("if they can't screenshot their own UI, how finished is the code?"). Greatest asset and greatest liability fight each other.
- **Casey (mobile, 390px):** the four 16:10 placeholders stack into one column, a long dead scroll of empty striped boxes at the bottom of an already-tall page.

## Minor Observations

- `h1` is the single word "Hoy" at up to 68px, maximum weight on the lowest-information element; the tagline carries the meaning.
- "Platform" card kicker is pure noise; replace with an OS icon or a differentiator.
- Inline style one-offs (`justifyContent: flex-start` on the All-releases row, changelog `paddingTop`) leak out of the otherwise-clean token discipline.
- Changelog page-head `h1` (42px) out-shouts landing section `h2` (32px), a cross-page scale inconsistency.
- Download button text is 3.3:1 on the violet brand, borderline; it passes the large/bold 3:1 bar but sits close.
- Line length: `beta-note` ~89ch, `callout` ~122ch, both over the 65-75ch target.

## Questions to Consider

1. If you deleted "How it works" right now, would the page be worse, or just shorter and more honest?
2. Your most distinctive asset is the honesty voice, so why is it confined to two paragraphs while the layout is indistinguishable from every other dark dev tool?
3. The one thing the app does that a screenshot can't convey is streaming tokens live, on a static export, what is the closest you can get to showing that?
4. Header says `Changelog, GitHub`; footer says `GitHub, License, Changelog`, which order is correct, and why does the site not know?
5. "Download" hands the user a GitHub page to search, is that honesty or a broken promise dressed as honesty?
