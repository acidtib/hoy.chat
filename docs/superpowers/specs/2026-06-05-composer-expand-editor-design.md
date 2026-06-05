# Composer Expand Message Editor (HOY-180)

## Problem

The `Maximize2` ghost button in the top right of the composer (`src/components/Composer.tsx`) renders once a thread has messages but does nothing: no `onClick`, no tooltip. The ticket asks for it to expand the editor, Zed-style.

## Behavior

- Clicking the button expands the editor to take roughly 90% of the thread panel height. The transcript stays mounted and visible in the remaining sliver at the top; it is not hidden or unmounted, so its scroll position survives untouched.
- While expanded, the icon flips to a minimize glyph (`Minimize2`) and the tooltip reads "Minimize Message Editor". Collapsed, the icon is `Maximize2` and the tooltip reads "Expand Message Editor". Clicking again returns the editor to the docked auto-grow layout.
- Expansion is per panel UI state: local React state in `ThreadView`, not persisted.
- Draft text survives toggling (it already lives in `ThreadView` state). Enter-to-send works in both states.
- The empty-thread layout (current `fill` mode) is unchanged and keeps no expand button.

## Design

### ThreadView (`src/components/ThreadView.tsx`)

- New local state: `const [expanded, setExpanded] = useState(false)`.
- The layout stays the normal flex column (Conversation on top, composer below). The docked composer wrapper goes from `shrink-0 border-t border-border` to also carry `h-[90%]` when expanded; the Conversation shrinks into the leftover space and never unmounts.
- The Composer in the has-messages branch receives:
  - `fill={expanded}` so the textarea stretches to fill the wrapper height,
  - `expanded={expanded}`,
  - `onToggleExpand={() => setExpanded((v) => !v)}`.
- The empty-thread branch passes neither `expanded` nor `onToggleExpand`, keeping today's behavior.

### Composer (`src/components/Composer.tsx`)

- New optional props: `expanded?: boolean`, `onToggleExpand?: () => void`.
- The expand button renders when `onToggleExpand` is provided (instead of the current `!fill` check). It gets `onClick={onToggleExpand}`, the icon `expanded ? Minimize2 : Maximize2`, and is wrapped in a `Tooltip` whose content and `aria-label` read "Minimize Message Editor" / "Expand Message Editor" to match the state.
- The textarea keeps `pr-10` whenever the button is shown (i.e., when `onToggleExpand` is set), even in fill mode, so text does not run under the button. The empty-thread fill keeps `pr-4`.
- The auto-grow `useLayoutEffect` already bails when `fill` is true; expanded mode rides that path.

## Out of scope

- The separate `Maximize2` button in the ThreadView header (panel-level expand) is a different control and stays as is.
- Persisting expansion across restarts or panels.

## Testing

The repo's test suite (`bun:test` under `tests/`) covers store logic only; there is no component rendering harness, and the expanded flag is local React state with no store involvement, so no new unit test fits. Verification is manual acceptance in the running app: expand grows the editor to ~90% of the panel, collapse restores the docked layout with transcript scroll intact, tooltip text matches the state, draft survives toggling, Enter-to-send works in both states.
