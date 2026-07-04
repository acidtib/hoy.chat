# Home Split Redesign - Design

## Goal

Redesign the desktop home screen from the current cramped, mobile-feeling combined dashboard (HOY-262 v1) into two focused surfaces:

1. **Home** becomes a clean, centered "start a new task" hero built on the *real* Hoy composer.
2. **Usage** moves out of home into its own full-screen view, opened from an icon in the bottom-right status bar next to the fleet toggle, where it can use the full desktop width (fixing the heatmap horizontal-scroll and the wasted-space complaints).

This supersedes the "combined dashboard" layout decision in HOY-262; the usage-stats data pipeline and derivations from HOY-262 are reused unchanged.

## Context (grounding)

- `App.tsx` renders the main body off a shared `bodyView` value: `"fleet"` -> `<FleetBoard/>`, else `panels.length === 0` -> `<HomePage/>`, else the panel strip (App.tsx:181-184).
- The fleet toggle is a `FooterIconButton` pinned to `ContextBar`'s bottom-right corner, toggling `bodyView` between `"fleet"` and `"panels"` with an `active` style (ContextBar.tsx:115-127).
- `Composer.tsx` (~1320 lines) is fully presentational: it takes no `threadId`/`sessionId` and never disables on a missing session. All inputs arrive as props (value/onChange/onSubmit, models/currentModel/onSelectModel, mode/onSelectMode, thinking/onSelectThinking, streaming/onStop, widgets/attachments, searchPaths/threads/slashCommands/projectPath). `canSend` depends only on `!disabled` + non-empty draft (Composer.tsx:797).
- The store already treats "a thread with no session" as first-class: `selectModel`, `setPermissionMode`, `selectThinkingLevel`, `setDraft`, and `submitPrompt` all defer their sidecar work until the first `submitPrompt`, which lazily spawns the session (store.ts:1265-1286 via `acquireSession` :2214, then `applyThreadModel` :2302 / `applyThreadPermissionMode` :2262).
- `ThreadView.tsx:245-276` shows the canonical composer prop wiring, all derived from `threadId`.
- Current home stubs: `HomePage.tsx` (embeds `UsageDashboard`) and `home/TaskComposer.tsx` (a plain textarea).

## Design

### 1. Home hero (`HomePage.tsx`, rewritten)

A vertically centered hero, no stats:

- A faint Hoy brand-mark watermark behind the title.
- Title: **"Start a new task in {targetProject.name}"** in Hoy's existing sans type (not serif). When there are no projects, fall back to the current "Open a project to start" affordance.
- The **real composer** (see section 2) as the focal element, in a constrained width (~max-w-2xl) so it reads as a hero, not a full-width bar.
- A compact **Recents** list beneath the composer (reuse the existing recents logic: up to 6 non-archived threads across projects, sorted by `updatedAt`, each opening its thread).
- The embedded `UsageDashboard` is removed from `HomePage`.

Target-project resolution keeps today's priority logic (explicit pick -> activeProjectId -> most-recent thread's project -> first project).

### 2. The home composer (reuse `Composer.tsx`)

Mount the real `Composer` on home so the user gets Hoy's actual model picker, permission-mode pill, `@` files, `/` commands, thinking selector, and send button - Hoy-styled, not ZCode-styled.

Because the composer is presentational, it is fed by **local home state** (not thread-keyed) to avoid creating phantom empty threads:

- Local React state on home: `draft`, `model` (defaults to store `defaultModel`), `permissionMode` (default `"default"`), `thinkingLevel` (default), and `attachments`.
- Props sourced without a thread: `models` from the store; `searchPaths` from the target `projectPath` (same as ThreadView); `threads` from the projects list; `projectPath` from the target project; `slashCommands` empty except the built-in `/compact` (matches the no-session case today); `canAttachImages` per the selected model.
- A small **header row** on the composer container: a functional **project pill** (opens the existing project chooser, sets the target project) and a **mocked branch pill** rendering a static `main` with a caret - visual only, no git switching (explicitly a mock, mirroring ZCode).

On submit, call a new store action:

```
startThread(projectId: string, message: string, opts: {
  model: ModelRef | null;
  permissionMode: PermissionMode;
  thinkingLevel: ThinkingLevel;
  images?: ImageAttachment[];
}): void
```

`startThread` creates the thread (`addThread` path), records the chosen model/permission/thinking onto the new (session-less) Thread, opens it, and issues the first prompt via the existing `submitPrompt` path - which lazily spawns the session and applies the deferred picks. This is true create-and-send (the auto-send deferred in HOY-262), with zero empty-thread churn because the thread is only minted on send. After submit, the home local state resets to defaults.

Empty submit (no draft, no attachments) is a no-op, same as `canSend`.

### 3. Usage view (`UsageView.tsx`, new) + footer toggle

- Add a third `bodyView` value `"usage"`. `App.tsx` renders `<UsageView/>` when `bodyView === "usage"` (branch added alongside the existing `"fleet"` branch, taking precedence over the panels/home branch).
- `UsageView` wraps the existing `UsageDashboard` in a full-body, scrollable container and lays it out for width: the 6 stat cards in a single row, `TokenTrendChart` and `ModelRanking` side by side, and the `ActivityHeatmap` sized to **fill the available width with no horizontal scroll** (responsive cell sizing / full 53-week grid that fits). `UsageDashboard` already self-loads via `refreshUsage()` on mount.
- Add a second `FooterIconButton` in `ContextBar`'s bottom-right cell, immediately left of the fleet toggle, using an activity/bar-chart icon, toggling `bodyView` between `"usage"` and `"panels"`, with the same `active` treatment as the fleet button. Toggling one view off returns to `"panels"` (which resolves to home when there are no panels).

### 4. Removed

- `home/TaskComposer.tsx` (the stub textarea) is deleted - superseded by the real composer.
- `UsageDashboard` is no longer imported by `HomePage`; it is imported by `UsageView`.

## Files changed

- Rewrite: `src/components/HomePage.tsx` (hero + real composer wiring + recents).
- New: `src/components/home/HomeComposer.tsx` (thin wrapper: local composer state + project/branch header + `startThread` on submit). Keeps `HomePage` focused.
- New: `src/components/UsageView.tsx` (full-body wrapper around `UsageDashboard`).
- Modify: `src/components/UsageDashboard.tsx` (desktop-width layout: card row, side-by-side trend/models) and `src/components/home/ActivityHeatmap.tsx` (fill-width, no-scroll sizing).
- Modify: `src/App.tsx` (`bodyView === "usage"` branch).
- Modify: `src/components/ContextBar.tsx` (second footer toggle).
- Modify: `src/state/store.ts` (`startThread` action; `bodyView` gains `"usage"`).
- Delete: `src/components/home/TaskComposer.tsx`.

## Out of scope

- Real git branch listing/switching (the branch pill is a static mock).
- Any change to the `usage_stats.rs` pipeline, the `get_usage_stats` command, or the `usage.ts` derivations.
- Persisting which `bodyView` was last open across restart (nice-to-have, not required).
- Serif hero typography.

## Testing / verification

- Existing bun tests continue to pass (164). The `usage.ts` derivation tests are unaffected.
- New unit coverage for `startThread`: creates a thread in the given project, records model/permission/thinking, and drives a first prompt (assert against the store, mirroring existing store tests in `tests/`).
- Live-verify in the dev app (`~/.hoyd`, Tauri MCP driver, screenshots): home hero renders with the real composer (model/permission/`@`//` work); typing a task and sending creates a thread and streams; no empty thread is left if home is opened and abandoned; the footer usage icon opens the full-width Usage view; the heatmap shows a full year with no horizontal scroll. Never touch production `~/.hoy`.
