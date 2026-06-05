# Sidebar Click Scrolls to Panel and Focuses Composer (HOY-183)

## Problem

Clicking a sidebar thread whose panel is already open only sets `activeThreadId` (`openThread` early-returns). If the panel is scrolled out of view in the strip, nothing visibly happens, and the composer is never focused on any open path.

## Design

### Store (`src/state/store.ts`)

- New state: `focusRequest: { threadId: string; nonce: number } | null`, initial null, not persisted.
- `openThread(id)` additionally sets `focusRequest: { threadId: id, nonce: (s.focusRequest?.nonce ?? 0) + 1 }` on both paths (already-open and fresh-open). The incrementing nonce makes repeated clicks on the same thread re-fire the effect.
- New action `focusPanel(id)`: sets only `activeThreadId`. `App.tsx`'s panel `onPointerDownCapture` handlers switch from `openThread` to it, so clicks inside a panel (transcript, header, inline rename) never move focus to the composer. While a panel is full screen the only visible panel is the expanded one, so `focusPanel` not touching `expandedThreadId` is correct.
- `openThread` callers that keep the focus behavior: sidebar rows, thread history, `addThread` (fresh "New thread" panels land focused; the empty-thread composer's existing `autoFocus` stays and is harmless alongside).

### ThreadView (`src/components/ThreadView.tsx`)

- Reads `focusRequest` and derives `const focusSignal = focusRequest?.threadId === threadId ? focusRequest.nonce : 0`.
- A ref on its root div; an effect on `focusSignal` (skipping 0) calls `scrollIntoView({ behavior: "smooth", inline: "nearest", block: "nearest" })`, which scrolls the horizontal strip to the panel. The footer slices stay aligned because smooth scrolling fires the strip's `onScroll` mirror. For a fresh panel the existing panel-add jump in `App.tsx` has already scrolled the strip; the `scrollIntoView` is then a no-op.
- Passes `focusSignal` to `Composer`.

### Composer (`src/components/Composer.tsx`)

- New optional prop `focusSignal?: number`. An effect focuses `textareaRef` whenever it changes to a non-zero value. No behavior change when the prop is absent or 0.

## Out of scope

- Keyboard shortcuts or other focus entry points (the store shape supports them later; nothing is built now).
- Restoring focus to whatever had it before a panel-click (panel clicks simply never move composer focus).

## Testing

- Store tests (`bun:test`): `openThread` sets `focusRequest` with the clicked threadId and bumps the nonce on repeat calls (both already-open and fresh-open paths); `focusPanel` sets `activeThreadId` without touching `focusRequest`; `addThread` leaves a `focusRequest` for the new thread.
- Manual acceptance: with overflowing panels scrolled right, clicking a left-most open thread's sidebar row smoothly scrolls its panel into view and puts the cursor in its composer; clicking the visible focused thread's row just focuses the composer; clicking inside another panel (transcript or header) does not steal composer focus; inline rename is not interrupted by panel clicks.
