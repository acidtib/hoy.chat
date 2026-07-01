# Design

Visual system for the hoy.chat marketing site. Captured from `app/globals.css`
(plain CSS, no Tailwind/PostCSS, to keep the static export build-step-free) and
the page components. Dark by default: the palette is set directly on `:root` /
`html` / `body`. The identity deliberately mirrors Hoy Desktop so the site and the
app read as one brand, with one intentional divergence noted under Radius.

## Theme

Dark, layered near-black with a faint cool cast and a violet brand accent, the
same workbench identity as the desktop app. Surfaces stack: `--bg` (page) below
`--panel` (cards, header) below `--panel-2` (code chips, inset). A sticky,
backdrop-blurred header floats over content. Centered single-column reading
measure (`--maxw: 900px`), generous vertical section rhythm.

## Color

Plain CSS custom properties (hex / rgba, not OKLCH here, matching the app's dark
values by eye):

| Token | Value | Role |
| --- | --- | --- |
| `--bg` | `#0e0e10` | page background |
| `--panel` | `#17171b` | cards, header, elevated surfaces |
| `--panel-2` | `#1d1d22` | code chips, deeper inset |
| `--border` | `rgba(255,255,255,0.09)` | hairline dividers |
| `--border-strong` | `rgba(255,255,255,0.14)` | ghost-button/placeholder borders |
| `--fg` | `#f4f4f6` | primary text |
| `--muted` | `#a2a2ad` | body/secondary text |
| `--muted-2` | `#7c7c86` | tertiary text, dates, tags |
| `--brand` | `#7c74ff` | violet accent (CTA, links, dot) |
| `--brand-fg` | `#f3f2ff` | text on brand |
| `--warn` | `#f0b429` | amber, beta/caution |
| `--warn-bg` | `rgba(240,180,41,0.12)` | beta badge / callout fill |
| `--warn-border` | `rgba(240,180,41,0.4)` | beta badge / callout border |

### Strategy

Restrained. One violet brand accent for the primary CTA, links, and the wordmark
dot; one amber (`--warn`) reserved exclusively for honesty signals (beta badge,
unsigned-build callout, pre-release changelog tags). Everything else is the
near-black + neutral-gray ramp. The amber is a deliberate, load-bearing signal
color, not decoration.

### Contrast

Target WCAG AA. `--muted` (`#a2a2ad`) on `--bg`/`--panel` clears body text;
`--muted-2` (`#7c7c86`) is the borderline case, keep it to non-essential small
text (dates, tags), not primary reading copy. The amber-on-amber-tint pairings
carry an icon and text, so they do not rely on color alone.

## Typography

- **Family**: Geist Variable (`@fontsource-variable/geist`), same as the app;
  `ui-sans-serif, system-ui` fallback. One family, hierarchy by weight/size.
- **Mono**: `ui-monospace, 'SF Mono', 'Geist Mono', monospace` for inline code
  and code blocks.
- **Scale**: fluid `clamp()` headings. Hero `clamp(40px, 8vw, 68px)`, line-height
  1.02, letter-spacing `-0.03em`; section headings `clamp(24px, 5vw, 32px)`;
  page-head `clamp(30px, 6vw, 42px)`. Body line-height 1.6, tagline/lead capped
  around 560-640px measure.
- Note: the current `.section-title` is a tracked-uppercase eyebrow (`letter-
  spacing: 0.12em`, `text-transform: uppercase`) repeated above sections; flagged
  as a slop tell to reconsider (see PRODUCT.md anti-references), not a pattern to
  extend.

## Radius

`--radius: 10px`. This is the one intentional divergence from the desktop app's
square theme (`--radius: 0rem`): as a brand surface the site is a touch softer.
Pills/dots use `999px`. If tightening brand consistency toward the app later, this
is the knob; for now the softer landing radius is deliberate.

## Components

Hand-written CSS classes (no component library):

- **Buttons** (`.btn`): `.btn-primary` (brand fill, lightens on hover),
  `.btn-ghost` (strong-border outline, panel fill on hover). ~120ms ease
  transitions on background/border.
- **Cards** (`.card`): panel fill, hairline border, 10px radius; used for the
  three platform install blocks and the empty state. A uniform 3-up grid
  (`repeat(3, 1fr)`, collapsing to 1 column <=720px); flagged as a card-grid slop
  tell to reconsider.
- **Badge / tags** (`.badge`, `.tag-pre`): amber pill with pulse dot for beta;
  small amber outline pill for pre-release changelog entries.
- **Callout** (`.callout`): amber-tinted honesty note (unsigned builds).
- **Beta note** (`.beta-note`): panel-boxed left-aligned disclaimer under the hero.
- **Markdown** (`.markdown`): changelog rendering (react-markdown + remark-gfm),
  with styled headings, links (brand), code chips, and pre blocks.
- **Screenshot placeholders** (`.shot`): dashed-border diagonal-stripe boxes with
  descriptive `role="img"` alt text; temporary until real captures land (HOY-224).

## Layout

- **Header** (`SiteHeader`): sticky, backdrop-blurred, hairline bottom border;
  wordmark (with brand dot) left, nav right (Changelog, GitHub, etc.).
- **Hero**: centered, beta badge, `h1`, tagline, boxed beta note, CTA row
  (Download vN + Changelog).
- **Sections**: Install (3 platform cards + unsigned-build callout), How it works
  (copy + screenshot grid). Consistent `44px 0` section padding, `--maxw`
  centered wrap.
- **Footer** (`SiteFooter`): hairline top border, links + version, wrapping flex.
- **Changelog page**: page-head + `.changelog-entry` list, each with version,
  date, optional pre-release tag, and rendered markdown body; graceful empty
  state when Releases are unavailable.
- Responsive: single breakpoint at 720px collapsing the grids to one column.

## Motion

- Minimal and functional: button background/border transitions (~120ms ease),
  sticky header with `backdrop-filter: blur(8px)`.
- No scroll-driven or entrance animation currently. If motion is added, honor
  `prefers-reduced-motion` with a crossfade or instant fallback; keep it subtle
  and never load-bearing for meaning.

## Anti-patterns (do not introduce)

Hype-page conventions (fake urgency, logo walls, inflated claims), gradient text,
glassmorphism beyond the one deliberate header blur, side-stripe accent borders,
hero-metric templates. Existing tells to rework rather than extend: the
tracked-uppercase per-section eyebrow, the uniform 3-card grid, and the dashed
screenshot placeholders.
