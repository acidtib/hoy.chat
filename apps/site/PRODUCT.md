# Product

## Register

brand

## Users

Developers evaluating or downloading Hoy Desktop. They arrive from a link, the
GitHub repo, or word of mouth, and want to answer three questions fast: what is
this, is it for me, how do I get it. They are technical and skeptical of hype;
they respect honesty about maturity (this is pre-1.0, bring-your-own-key,
experimental). The job to be done is: understand Hoy in one screen and get to a
download for the right platform. A secondary audience reads the changelog to
track what shipped.

## Product Purpose

The `hoy.chat` marketing site: a single-page landing plus a changelog, statically
exported (Next.js 16, `output: 'export'`) and deployed to Cloudflare Pages on
hoy.chat. It exists to explain Hoy Desktop, set honest expectations about its
beta status, and route visitors to the latest GitHub release for their platform.
The download version and changelog are resolved from GitHub Releases at build
time, so a new release refreshes the site on the next deploy. Success is a
visitor understanding what Hoy is and leaving with the correct build, trusting
the project because it was straight with them.

## Brand Personality

Shared with the `hoy.chat` umbrella brand and Hoy Desktop: focused, precise,
quietly confident. Three words: calm, sharp, capable. As a brand surface the site
carries a bit more warmth and voice than the app, but stays honest and low-hype;
it does not oversell. The beta status is stated plainly and up front, not buried.
The visual identity deliberately mirrors the desktop app (layered near-black,
violet brand accent, Geist) so the site and the product feel like one thing.
Aesthetic peers: Zed's site (crisp, dark, developer-honest), Linear (calm,
high-craft, disciplined), the way strong developer tools present themselves,
technically credible, not marketing-department glossy.

## Anti-references

Not a hype-driven SaaS launch page: no fake urgency, no inflated claims, no
enterprise-logo wall, no "AI-powered everything" copy. No AI-slop tells:
hero-metric templates, identical icon-heading-text card grids, gradient text,
glassmorphism-by-default, or a tracked-uppercase eyebrow above every section. It
should read like a developer tool's honest home page, not a growth-team funnel.
Known slop tells currently present in the code (tracked-uppercase section
eyebrows, a uniform 3-card grid, dashed screenshot placeholders) are candidates
to rework, not patterns to extend.

## Design Principles

- **Honesty is the pitch.** The strongest move is telling the truth about a
  pre-1.0 tool: state the beta status, the bring-your-own-key model, and the
  unsigned-build caveats plainly and early. Trust converts better than hype.
- **One screen, one job.** Get a technical visitor from "what is this" to the
  right download fast. Every section earns its place against that path.
- **Feels like the product.** Mirror the desktop app's dark, sharp, restrained
  identity so the site and the app are unmistakably one brand.
- **Voice over volume.** A brand surface may be warmer and more expressive than
  the app, but never louder than the substance. Show the tool; do not shout.
- **Static and durable.** Fully static export, version and changelog pulled from
  the source of truth (GitHub Releases) at build time. No runtime dependencies,
  nothing to rot.

## Accessibility & Inclusion

Target WCAG AA contrast across the dark palette: body >=4.5:1, large text >=3:1.
Watch `--muted` (`#a2a2ad`) and `--muted-2` (`#7c7c86`) on the near-black
`--bg`/`--panel`; `--muted-2` is the likely borderline case for small text.
Honor `prefers-reduced-motion` on any animation (the header uses a blur/sticky
treatment; keep motion optional). Do not convey state (beta badge, warnings)
through color alone; the existing badge and callouts pair color with text and
icon, keep that. Descriptive alt text on all imagery, including the screenshot
placeholders until real captures replace them.
