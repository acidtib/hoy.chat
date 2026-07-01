import { useEffect, useState } from "react";

// Shared drag lifecycle for column resize handles (the sidebar edge and the
// panel dividers). Tracks a dragging flag, wires window pointer listeners while
// active, and sets/restores the body drag cursor. Listeners tear down on
// pointerup/cancel AND on unmount (the handle removed mid-drag), so the drag
// never leaks past the gesture or leaves the cursor stuck.
//
// `onMove` must be stable (wrap it in useCallback) or the listeners re-bind on
// every render.
export function useGlobalDrag(onMove: (e: PointerEvent) => void) {
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) return;
    function stop() {
      setDragging(false);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
  }, [dragging, onMove]);

  return { dragging, startDrag: () => setDragging(true) };
}
