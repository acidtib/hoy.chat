# Product

## Register

product

## Users

Developers who run the Pi coding agent locally and want a native desktop GUI
instead of a terminal REPL. They bring their own model API key. Their context is
a focused work session: they open a project, converse with the agent, watch it
stream reasoning and tool calls, and steer it. They are technical, keyboard-fluent,
and often dogfooding (Hoy is built with Hoy). The primary task on any screen is
reading and directing an agent run: the transcript is the workspace, everything
else is chrome that should recede.

## Product Purpose

Hoy Desktop is a native (Tauri v2 + React) desktop app that spawns the Pi coding
agent as a sidecar process and streams its work into a real desktop interface:
token-by-token output, tool calls, reasoning, session history. It exists because
a coding agent deserves a first-class native surface (session sidebar, model
picker, settings, multi-session foundation) rather than a scrollback buffer. It
is one app under the `hoy.chat` umbrella; more are planned. Success is a user
launching, configuring a key, picking a model, and running an agent turn that
streams cleanly, with past sessions restoring on restart, all feeling like a
flagship native tool and not a web page in a window.

## Brand Personality

Focused, precise, quietly confident. Three words: calm, sharp, capable. The UI is
a workbench, not a showroom: low-chrome, dense where density serves the expert,
self-effacing where it does not (thin scrollbars, no decorative flourish). It
signals engineering seriousness through restraint. Motion is intentional and
minimal; the agent's output is the star. The aesthetic peers are Zed (fast,
crisp, keyboard-first native editor; the composer is benchmarked against it),
Linear (precise, calm, high-craft product UI with disciplined palette and subtle
motion), OpenAI Codex / ChatGPT desktop (the agent-desktop shape: transcript plus
tool calls), and Raycast / terminal tools (command-driven, monospace-adjacent,
power-user speed).

## Anti-references

Not another rounded SaaS: avoid soft rounded corners, gradient-heavy heroes,
pastel marketing palettes, and consumer-cute flourishes. The square theme
(`--radius: 0rem`) is a deliberate identity choice; keep corners sharp. No
AI-slop tells: no hero-metric templates, no identical icon-heading-text card
grids, no tiny tracked-uppercase eyebrows above every section, no gradient text,
no glassmorphism-by-default, no side-stripe accent borders. This is a tool for
people who live in editors and terminals; it should read that way, never like a
landing page bolted onto an app.

## Design Principles

- **The transcript is the product.** Every other surface (sidebar, titlebar,
  composer, settings) is chrome that must recede so the agent's streaming output
  stays the focal point. When in doubt, remove chrome, do not add it.
- **Restraint is the brand.** Confidence is shown by what is left out. Square
  corners, one brand accent used sparingly, thin scrollbars, minimal motion.
  Elegance through discipline, not decoration.
- **Native, not web-in-a-window.** Match desktop expectations: instant feedback,
  keyboard-first affordances, honest loading and streaming states, real
  cross-restart persistence. It should feel like Zed, not like a website.
- **Respect the expert.** Users are technical and keyboard-fluent. Favor density
  and speed over hand-holding; do not over-explain. Power-user affordances
  (slash commands, model/thinking control, steering) are first-class.
- **Honest state.** Streaming, thinking, tool calls, errors, empty and queued
  states are all shown truthfully. Never fake progress or hide failure; surface
  errors as structured, legible states.

## Accessibility & Inclusion

Target WCAG AA contrast across the dark-first palette: body text >=4.5:1, large
text (>=18px, or bold >=14px) >=3:1, placeholders held to the 4.5:1 body bar.
Verify against the layered near-black surfaces, where muted-foreground on muted
is the most likely failure. Honor `prefers-reduced-motion` on every animation
with a crossfade or instant alternative; motion is never load-bearing for
meaning. Do not rely on color alone to convey state (streaming, error, queued);
pair with text, icon, or shape.
