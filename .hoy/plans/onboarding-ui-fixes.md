# Onboarding UI Fixes Implementation Plan

**Goal:** Fix three onboarding UX issues: default theme to System instead of Dark, collapse sidebar during onboarding and expand after, and disable global toggle buttons (Show Tree, Show Usage Stats, Show FleetView) while onboarding is active.

**Architecture:** Three independent changes in the renderer layer. The theme default changes in the prefs store (fresh installs only; existing stored prefs are unaffected). The sidebar collapse is driven by a `showOnboarding`-watching effect in App.tsx, using a new `setSidebarCollapsed` setter on the session store. The button disable is a prop threaded from App.tsx into TitleBar and ContextBar; their internal button wrappers gain a `disabled` prop that passes through to the shadcn Button.

**Tech Stack:** React, TypeScript, Zustand, shadcn/ui

## Design rationale
- **Theme default**: `PREFS_DEFAULTS.theme` is `"dark"` at `state/prefs.ts:86`. Changing it to `"system"` only affects fresh installs because zustand's `persist` middleware merges the stored partial over defaults. `ThemeController` already handles `"system"` by reading `prefers-color-scheme` and subscribing to OS changes. No other code paths assume a dark initial state.
- **Sidebar toggle**: The store has `toggleSidebar` (a blind flip) but no directed setter. Adding `setSidebarCollapsed(collapsed)` avoids flaky toggling logic. A `useEffect` in App.tsx watches `showOnboarding` (computed from `providerBootstrapped`, `providerConfigured`, `onboardingCompleted`) and calls the setter. When onboarding shows, force-collapse; when it disappears, force-open. The `finalizeBootstrap` path that auto-completes onboarding never triggers `showOnboarding === true`, so the sidebar stays at its default (open), unchanged.
- **Button disable**: `showOnboarding` is computed locally in App.tsx, not in a store. Passing it as a prop to TitleBar and ContextBar is the most direct approach. TitleBarButton and FooterIconButton already spread `onClick` and other props to the shadcn Button, which natively supports `disabled`. Adding a `disabled` prop to each wrapper and spreading it through keeps the change minimal. During onboarding: "Show Usage Stats" and "Show FleetView" in TitleBar, "Show Tree" in ContextBar all gain `disabled={onboarding}`.

## Key changes
- **`state/prefs.ts`**: Change `theme` default from `"dark"` to `"system"`.
- **`state/store.ts`**: Add `setSidebarCollapsed: (collapsed: boolean) => void` action.
- **`App.tsx`**: Add `useEffect` to collapse/expand sidebar based on `showOnboarding`; pass `onboarding={showOnboarding}` to TitleBar and ContextBar.
- **`TitleBar.tsx`**: Accept optional `onboarding` prop; add `disabled` to `TitleBarButton`; disable Usage Stats and FleetView buttons during onboarding.
- **`ContextBar.tsx`**: Accept optional `onboarding` prop; add `disabled` to `FooterIconButton`; disable Show Tree button during onboarding.

## Steps

1. **Change theme default** in `state/prefs.ts` line 86:
   - `theme: "dark"` -> `theme: "system"`
   - No other changes needed; ThemeController, ThemeSelector, and OnboardingPage all read this pref and handle `"system"` correctly. Verify: `bun test` (no theme-specific tests exist, but existing tests must pass).

2. **Add `setSidebarCollapsed` setter** in `state/store.ts`:
   - Add `setSidebarCollapsed: (collapsed: boolean) => void` to the `SessionStore` interface (around line 467, near `toggleSidebar`)
   - Add implementation in the store's `create` body (near line 995, after `toggleSidebar`): `setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed })`
   - Verify: `bun test`

3. **Add onboarding sidebar effect** in `App.tsx`:
   - Read `setSidebarCollapsed` from `useSessionStore` in the destructured lines (around line 45)
   - Add a `useEffect` after the `showOnboarding` computation (after line 190):
     ```ts
     useEffect(() => {
       if (showOnboarding) {
         setSidebarCollapsed(true);
       } else if (providerBootstrapped) {
         setSidebarCollapsed(false);
       }
     }, [showOnboarding, providerBootstrapped, setSidebarCollapsed]);
     ```
   - Verify: `bun test`

4. **Thread onboarding prop to TitleBar** in `App.tsx`:
   - `App.tsx` line ~210 where `<TitleBar />` is rendered: add `onboarding={showOnboarding}` prop.
   - Verify: `bun run check:ts`

5. **Disable TitleBar buttons during onboarding** in `TitleBar.tsx`:
   - Add `onboarding?: boolean` prop to `TitleBar` component signature
   - Add `disabled?: boolean` prop to `TitleBarButton` component signature
   - Spread `disabled` into the `<Button>` props: add `disabled={disabled}` after `onClick={onClick}`
   - On the Usage Stats button (line ~72): add `disabled={onboarding}`
   - On the FleetView button (line ~79): add `disabled={onboarding}`
   - Verify: `bun run check:ts`

6. **Thread onboarding prop to ContextBar** in `App.tsx`:
   - `App.tsx` line ~304 where `<ContextBar slicesRef={footerSlicesRef} />` is rendered: add `onboarding={showOnboarding}` prop.
   - Verify: `bun run check:ts`

7. **Disable Show Tree button during onboarding** in `ContextBar.tsx`:
   - Add `onboarding?: boolean` prop to `ContextBar` component signature
   - Add `disabled?: boolean` prop to `FooterIconButton` component signature
   - Spread `disabled` into the `<Button>` props: add `disabled={disabled}` after `onClick={onClick}`
   - On the Show Tree button (line ~118): add `disabled={onboarding}`
   - Verify: `bun run check:ts`

## Test plan
- `bun test` — existing test suite must pass with no regressions
- `bun run check:ts` — TypeScript compilation must pass
- `bun run clippy` — Rust must be unaffected (this is renderer-only)
- Manual verification: fresh dev instance (`bun run tauri:dev` with empty `~/.hoyd/` and no `localStorage`):
  1. Onboarding opens with System theme selected (not Dark)
  2. Sidebar is collapsed during onboarding (no sidebar visible)
  3. Show Tree button in footer is disabled (opacity reduced, non-interactive)
  4. Show Usage Stats and Show FleetView buttons in title bar are disabled
  5. After adding a provider key and clicking Continue, sidebar opens automatically and all three buttons become active

## Assumptions and risks
- **Assumption**: No other code reads `theme` during boot and assumes it will be `"dark"` before any user interaction. The `ThemeController` effect runs on mount and applies whatever value is in the store; `"system"` is already handled. The onboarding step indicator reads the live theme for its label, which works with any value.
- **Assumption**: The sidebar opening effect after onboarding should only fire when `providerBootstrapped` is true (to avoid toggling it open during the initial loading spinner phase). The `useEffect` guards against this with the `providerBootstrapped` check.
- **Risk**: If the user refreshes the page or closes/reopens during onboarding, the sidebar will be collapsed again on re-entry (the `useEffect` re-runs). This is desirable behavior.
- **Risk**: The `showOnboarding` value is not in a store, so TitleBar and ContextBar re-render when it changes (i.e., when onboarding completes). These are lightweight components with no expensive renders, so this is fine.

## Critical files
- `apps/desktop/src/state/prefs.ts`
- `apps/desktop/src/state/store.ts`
- `apps/desktop/src/App.tsx`
- `apps/desktop/src/components/TitleBar.tsx`
- `apps/desktop/src/components/ContextBar.tsx`
