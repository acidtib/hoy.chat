# Design

Visual system for Hoy Desktop. Captured from the live token set in
`src/index.css` and the shadcn/ui + AI Elements component layer. Dark-first: the
app ships with `<html class="dark">` and the light palette exists but is not the
default surface. All colors are OKLCH.

## Theme

Dark-first, layered near-black with a faint cool cast (hue ~285). The background
sits below panels so the sidebar and cards read as elevated surfaces, a
Zed/Codex-style workbench. The identity move is the **square theme**: `--radius`
is `0rem`, so every `rounded-*` utility (all `calc()` multiples of `--radius`)
renders with sharp corners. Only `rounded-full` is exempt, keeping dots, switch
thumbs, and avatars round. Chrome recedes (thin self-effacing scrollbars, hairline
borders); the streaming transcript is the focal plane.

## Color

Semantic tokens (shadcn convention). Light values shown for reference; dark is the
shipped default.

### Dark (default)

| Token | Value | Role |
| --- | --- | --- |
| `--background` | `oklch(0.165 0.004 285)` | app base, below panels |
| `--foreground` | `oklch(0.97 0.002 285)` | primary text |
| `--card` | `oklch(0.205 0.005 285)` | elevated panel surface |
| `--popover` | `oklch(0.215 0.006 285)` | menus, dropdowns |
| `--primary` | `oklch(0.95 0.002 285)` | primary button bg (near-white) |
| `--primary-foreground` | `oklch(0.2 0.006 285)` | text on primary |
| `--secondary` | `oklch(0.27 0.006 285)` | secondary surface |
| `--muted` | `oklch(0.255 0.005 285)` | muted surface |
| `--muted-foreground` | `oklch(0.66 0.008 285)` | secondary text |
| `--accent` | `oklch(0.275 0.007 285)` | hover surface |
| `--destructive` | `oklch(0.68 0.17 22.5)` | error/danger |
| `--border` | `oklch(1 0 0 / 9%)` | hairline dividers |
| `--input` | `oklch(1 0 0 / 12%)` | input borders |
| `--ring` | `oklch(0.62 0.16 274)` | focus ring (brand-tinted) |
| `--brand` | `oklch(0.62 0.17 274)` | indigo/violet accent |
| `--brand-foreground` | `oklch(0.98 0.01 274)` | text on brand |
| `--agent` | `oklch(0.72 0.12 195)` | subagent/parent thread identity (teal) |
| `--sidebar` | `oklch(0.185 0.004 285)` | sidebar surface |
| `--sidebar-primary` | `oklch(0.62 0.17 274)` | active item (brand) |

### Light (secondary)

Neutral chroma-0 ramp: `--background: oklch(1 0 0)`, `--foreground:
oklch(0.145 0 0)`, `--muted-foreground: oklch(0.556 0 0)`, `--border:
oklch(0.922 0 0)`, `--destructive: oklch(0.577 0.245 27.325)`, `--brand:
oklch(0.55 0.18 274)`.

### Strategy

Restrained. A single brand hue (indigo/violet, ~274) carries identity through the
ring, active sidebar item, and `chart-1`; everything else is a tinted-neutral
ramp (chroma <=0.008, hue ~285). The brand accent is used sparingly, never as a
fill across large surfaces. Active-panel affordance is a `border-t-brand/70` top
edge, not a filled state. A second reserved hue, `--agent` (teal, ~195), marks subagent threads and the threads running them (see HOY-236); it is the only non-brand identity hue and never fills large surfaces.

### Contrast

Target WCAG AA. Watch `--muted-foreground` on `--muted`/`--card` in dark, the
most likely failure; bump toward `--foreground` if a specific pairing is close.
Placeholders held to the 4.5:1 body bar, not a lighter gray.

## Typography

- **Sans / heading**: Geist Variable (`@fontsource-variable/geist`). One family
  across UI and headings; hierarchy via weight and size, not a second family.
- **Mono**: `ui-monospace, 'SF Mono', 'Geist Mono', 'JetBrains Mono', monospace`
  for code blocks (Shiki), inline code, and technical values.
- `-webkit-font-smoothing: antialiased`, `text-rendering: optimizeLegibility`.
- Body/UI text runs small and dense (`text-sm` / `text-xs` throughout) to suit an
  expert, information-rich tool. This is app UI, not marketing; no display hero
  scale.

## Radius

`--radius: 0rem` (square theme). Radius tokens still exist and scale off it
(`--radius-sm` = 0.6x, `--radius-md` = 0.8x, `--radius-lg` = 1x, up to
`--radius-4xl` = 2.6x), so all resolve to 0. Some components clamp to a small
literal for tiny controls (e.g. `rounded-[min(var(--radius-md),10px)]`), which
also resolves to 0 while `--radius` is 0. `rounded-full` is the deliberate
exception for circular elements. Keep corners sharp; do not reintroduce rounding.

## Components

Foundation is **shadcn/ui** (`src/components/ui/*`) plus **AI Elements**
(`src/components/ai-elements/*`), used as presentational shadcn components driven
by Hoy's own state (the Vercel AI SDK is intentionally not wired; tokens stream
from Pi over a Tauri Channel).

- **Button** (`ui/button.tsx`, CVA): variants `default` (near-white primary),
  `outline`, `secondary`, `ghost`, `destructive` (tinted, not solid fill),
  `link`. Sizes `xs`/`sm`/`default`/`lg` + icon variants. Active state nudges
  `translate-y-px`; focus shows a 3px brand ring. `cursor-pointer`, `font-medium`.
- **AI Elements**: Conversation, Message, Tool, Reasoning (with live thinking
  timer), Code Block (Shiki), Model Selector, Shimmer, Plan (the proposed-plan
  handoff card, HOY-259). These render the transcript.
- **Primitives in use**: Dialog, AlertDialog (destructive confirms), DropdownMenu,
  Select, Command (cmdk, slash-command palette), Collapsible, Switch, Tooltip,
  ScrollArea, Badge, Input/Textarea/InputGroup, Button/ButtonGroup, Separator,
  Card (`ui/card.tsx`, added with the AI Elements Plan component in HOY-259).
- **Markdown**: Streamdown renders streamed assistant markdown.
- Cards are genuine elevated surfaces (panels / the plan handoff), never a
  decorative grid, and never nested. There is now a real `ui/card` primitive (an
  elevated `bg-card` surface with a hairline ring); the Plan component builds on
  it, and new card-shaped surfaces should reach for it rather than hand-rolling
  another bordered div. Several older surfaces (ApprovalCard, QuestionnaireCard,
  notice rows) predate it and remain styled divs — fair game for a later
  consolidation pass.

## Layout

App shell (`App.tsx`), the Zed/Codex desktop shape:

- **Sidebar** (left, collapsible): session/project tree or history view. Keeps the
  top-left corner; the title bar spans only the main column beside it.
- **Title bar** (top of main column): model picker + settings, custom window
  chrome (`decorations: false`).
- **Panel strip** (center): one or more `ThreadView` panels side by side,
  horizontally scrollable, user-resizable via a zero-width drag handle straddling
  each seam. Active panel marked by a `border-t-brand/70` top edge. Supports a
  full-screen expanded single panel. Empty state renders `HomePage`.
- **Context bar** (footer): per-panel stats slices whose horizontal scroll mirrors
  the panel strip.
- Multi-session by design: layout never hardcodes a single session even when one
  is open.

## Motion

- Library available: `motion` (Framer Motion successor). Motion is intentional and
  minimal; the agent's streaming output is the star, not the chrome.
- Reasoning block has a live ticking elapsed timer; Shimmer marks pending output.
- Transitions are short and functional (`transition-all` / `transition-colors` on
  interactive states, resize-handle hover, focus ring).
- Honor `prefers-reduced-motion` with a crossfade or instant alternative on every
  animation. Motion is never load-bearing for meaning.

## Scrollbars

Custom `.scrollbar-thin`: `scrollbar-width: thin`, thumb is a `color-mix` of
`--foreground` at 14% (24% on hover) with a transparent track and 3px inset via
`background-clip: content-box`. Self-effacing by design.

## Anti-patterns (do not introduce)

Rounded SaaS softness (the square theme is identity), gradient text, side-stripe
accent borders, hero-metric templates, identical icon-heading-text card grids,
tracked-uppercase eyebrows, glassmorphism-by-default. This is a tool for people
who live in editors and terminals; keep it sharp and low-chrome.
