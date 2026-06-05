# Composer Expand Message Editor Implementation Plan (HOY-180)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the composer's expand button toggle the editor between the docked auto-grow layout and a Zed-style expanded layout taking ~90% of the thread panel.

**Architecture:** `expanded` is local React state in `ThreadView`. The layout stays the normal flex column; when expanded, the docked composer wrapper gains `h-[90%]` and the Composer renders in its existing `fill` mode, so the Conversation shrinks into the leftover sliver without unmounting (scroll position survives). The Composer grows two optional props, `expanded` and `onToggleExpand`, which drive the button's visibility, icon, tooltip, and click handler.

**Tech Stack:** React + TypeScript, Tailwind, shadcn Tooltip (already in the repo), lucide icons. No store changes, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-05-composer-expand-editor-design.md`

**Testing note:** The repo's `bun:test` suite covers store logic only; there is no component rendering harness and this change is pure local UI state, so verification is `bun run build` (tsc) plus manual acceptance in the running app. Do not add a test harness for this.

---

### Task 1: Composer props, button, tooltip

**Files:**
- Modify: `src/components/Composer.tsx`

- [x] **Step 1: Add `Minimize2` to the lucide import and import Tooltip components**

```tsx
import {
  AtSign,
  ChevronDown,
  Maximize2,
  Minimize2,
  Plus,
  SendHorizontal,
} from "lucide-react";
```

and alongside the other `@/components/ui` imports:

```tsx
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
```

- [x] **Step 2: Add the new props**

Extend the props object and its type (after `disabled`):

```tsx
  disabled = false,
  expanded = false,
  onToggleExpand,
}: {
  ...
  disabled?: boolean;
  expanded?: boolean;
  onToggleExpand?: () => void;
}) {
```

- [x] **Step 3: Replace the dead button with a working tooltipped toggle**

Replace the current `{!fill && ( <Button ... aria-label="Expand" ... /> )}` block (lines 75-84) with:

```tsx
      {onToggleExpand && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute right-1.5 top-1.5 size-7 text-muted-foreground"
              onClick={onToggleExpand}
              aria-label={
                expanded ? "Minimize Message Editor" : "Expand Message Editor"
              }
            >
              {expanded ? (
                <Minimize2 className="size-3.5" />
              ) : (
                <Maximize2 className="size-3.5" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {expanded ? "Minimize Message Editor" : "Expand Message Editor"}
          </TooltipContent>
        </Tooltip>
      )}
```

Visibility now keys off `onToggleExpand` instead of `!fill`: the empty-thread fill layout passes no handler and stays buttonless; the expanded state is fill-with-a-minimize-button.

- [x] **Step 4: Keep textarea padding clear of the button in expanded fill mode**

In the textarea `className`, replace the fill branch `"min-h-0 flex-1 overflow-y-auto pr-4"` with:

```tsx
          fill
            ? cn(
                "min-h-0 flex-1 overflow-y-auto",
                onToggleExpand ? "pr-10" : "pr-4",
              )
            : "max-h-[240px] min-h-[80px] overflow-y-auto pr-10",
```

- [x] **Step 5: Clear the JS-set inline height when entering fill mode**

The auto-grow effect currently bails before touching the element when `fill` is true, leaving a stale inline `height` from docked mode that would fight `flex-1`. Replace the effect body:

```tsx
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (fill) {
      el.style.height = "";
      return;
    }
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value, fill]);
```

### Task 2: ThreadView state and layout wiring

**Files:**
- Modify: `src/components/ThreadView.tsx`

- [x] **Step 1: Add the expanded state**

Next to the other local state (`draft`, `editingTitle`):

```tsx
  const [expanded, setExpanded] = useState(false);
```

- [x] **Step 2: Wire the Composer props**

In the `composer` element, change `fill={!hasMessages}` and add the two new props:

```tsx
      fill={!hasMessages || expanded}
      autoFocus={!hasMessages}
      disabled={streaming}
      expanded={expanded}
      onToggleExpand={
        hasMessages ? () => setExpanded((v) => !v) : undefined
      }
```

- [x] **Step 3: Grow the docked wrapper when expanded**

Replace the docked composer wrapper:

```tsx
          <div
            className={cn(
              "shrink-0 border-t border-border",
              expanded && "flex h-[90%] flex-col",
            )}
          >
            {composer}
          </div>
```

`h-[90%]` is relative to the panel's flex column; the Conversation (`flex-1 min-h-0`) absorbs the remaining sliver. `flex flex-col` lets the Composer's internal `h-full` fill the wrapper.

### Task 3: Verify and commit

- [x] **Step 1: Typecheck and build**

Run: `bun run build`
Expected: tsc and vite both exit 0.

- [x] **Step 2: Run the existing test suite**

Run: `bun test`
Expected: all existing tests pass (none touch these components, this is a regression guard).

- [x] **Step 3: Manual acceptance in the running app**

Launch with `bun run tauri:dev`. In a thread with messages:
- Hover the top-right composer icon: tooltip reads "Expand Message Editor".
- Click: editor grows to ~90% of the panel, transcript sliver stays visible at top, icon flips to minimize, tooltip reads "Minimize Message Editor".
- Type a draft, toggle both ways: draft text intact, transcript scroll position intact.
- Enter sends in both states.
- Empty thread: no expand button in the fill layout.

- [x] **Step 4: Commit**

```bash
git add src/components/Composer.tsx src/components/ThreadView.tsx docs/superpowers/plans/2026-06-05-composer-expand-editor.md
git commit -m "HOY-180: composer expand button toggles a 90% editor layout"
```
