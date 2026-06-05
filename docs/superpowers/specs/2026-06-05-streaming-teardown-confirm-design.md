# Confirm Teardown of a Streaming Thread (HOY-182)

## Problem

Closing a thread panel while the model is streaming kills the sidecar immediately (kill-on-close in `closePanel`), cutting off the in-flight response with no warning. Archive and delete route through the same teardown.

## Design

### Store (`src/state/store.ts`)

- New state: `pendingTeardown: { action: "close" | "archive" | "delete"; threadId: string } | null`, initial null, not persisted.
- New actions:
  - `requestTeardown(action, threadId)`: when `streaming[threadId]` is falsy, dispatch the matching real action immediately (identical to today, no dialog). When streaming, set `pendingTeardown` and do nothing else.
  - `confirmTeardown()`: dispatch the pending action, clear `pendingTeardown`. No-op when nothing pending.
  - `cancelTeardown()`: clear `pendingTeardown` only; the stream keeps running.
- The real actions (`closePanel`, `archiveThread`, `deleteThread`) are untouched and stay synchronous; the streaming gate lives in one place. If the stream finishes while the dialog is open, confirm still proceeds (all three actions are safe on idle threads). Confirming for a thread that no longer exists no-ops (the actions already guard).

### Dialog (`src/components/ConfirmCloseDialog.tsx`)

- shadcn AlertDialog (new `src/components/ui/alert-dialog.tsx` via the shadcn CLI). One global instance rendered in `App`, the same pattern as `SettingsModal`, driven by `pendingTeardown`.
- Title: "Response still streaming". Body: "A response is still streaming. Close this thread and stop the response?" with the verb per action (close / archive / delete). Action button label per action: "Stop and close" / "Stop and archive" / "Stop and delete"; the delete variant uses destructive styling. Cancel button: "Cancel".
- Cancel, Escape, and overlay dismiss all call `cancelTeardown`. The action button calls `confirmTeardown`.

### Call sites

All teardown call sites switch from the direct store action to `requestTeardown`:

- `src/App.tsx`: both `onClose` handlers (normal and full-screen panel branches) use `requestTeardown("close", id)`.
- `src/components/ThreadView.tsx`: header menu "Archive thread" uses `requestTeardown("archive", threadId)`.
- `src/components/Sidebar.tsx`: thread row hover archive button uses `requestTeardown("archive", thread.id)`.
- `src/components/ThreadHistory.tsx`: row archive uses `requestTeardown("archive", thread.id)`; row delete uses `requestTeardown("delete", thread.id)`. Unarchive stays direct (no teardown involved).

## Out of scope

- A native OS dialog (tauri-plugin-dialog). Considered and rejected: this is an app-internal confirmation, the in-app AlertDialog matches the shadcn design system, and the native path would add a Rust dependency plus capability for no benefit.
- Confirming app quit while streaming.

## Testing

- Store tests (`bun:test`): for each action kind, idle thread runs immediately with no pending state; streaming thread sets `pendingTeardown` and tears nothing down; `cancelTeardown` leaves the panel open and the streaming flag set; `confirmTeardown` produces exactly the direct action's end state.
- Manual acceptance: with a real response streaming, X / archive / delete each raise the dialog; Cancel keeps the stream rendering; confirm stops and closes/archives/deletes; idle threads close/archive/delete with no dialog.
