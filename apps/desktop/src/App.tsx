import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Sidebar } from "@/components/Sidebar";
import { ThreadHistory } from "@/components/ThreadHistory";
import { FleetBoard } from "@/components/fleet/FleetBoard";
import { HomePage } from "@/components/HomePage";
import { UsageView } from "@/components/UsageView";
import { ThreadView } from "@/components/ThreadView";
import { ContextBar } from "@/components/ContextBar";
import { ForkPicker } from "@/components/tree/ForkPicker";
import { TreeNavigator } from "@/components/tree/TreeNavigator";
import { ConfirmCloseDialog } from "@/components/ConfirmCloseDialog";
import { TitleBar, WindowResizeHandles } from "@/components/TitleBar";
import { SettingsModal } from "@/components/settings/SettingsModal";
import { TooltipProvider } from "@/components/ui/tooltip";
import { activeSessionId, getState, setKeepAwake } from "@/lib/ipc";
import { refreshProviderData } from "@/lib/refresh";
import { cn } from "@/lib/utils";
import { useGlobalDrag } from "@/lib/useGlobalDrag";
import { useSessionStore, findThread } from "@/state/store";
import { usePrefsStore } from "@/state/prefs";
import { isSubagentThread, childThreadIdsOf } from "@/state/delivery";
import type { PiState } from "@/lib/types";

function App() {
  const panels = useSessionStore((s) => s.panels);
  const projects = useSessionStore((s) => s.projects);
  const activeThreadId = useSessionStore((s) => s.activeThreadId);
  const expandedThreadId = useSessionStore((s) => s.expandedThreadId);
  const sidebarCollapsed = useSessionStore((s) => s.sidebarCollapsed);
  const sidebarView = useSessionStore((s) => s.sidebarView);
  const bodyView = useSessionStore((s) => s.bodyView);
  const rightDock = useSessionStore((s) => s.rightDock);
  const initWorkspace = useSessionStore((s) => s.initWorkspace);
  const activeId = useSessionStore((s) => s.activeSessionId);
  const setDefaultModel = useSessionStore((s) => s.setDefaultModel);
  const setBodyWidth = useSessionStore((s) => s.setBodyWidth);
  const requestTeardown = useSessionStore((s) => s.requestTeardown);
  const focusPanel = useSessionStore((s) => s.focusPanel);
  const setActiveSessionId = useSessionStore((s) => s.setActiveSessionId);

  // Full screen: the one panel rendered while set, at full body width via CSS.
  // Stored widths are untouched, so exiting restores the exact layout.
  const expandedPanel = panels.find((p) => p.id === expandedThreadId) ?? null;

  // Restore the persisted projects -> threads tree on boot (then autosave kicks in).
  useEffect(() => {
    void initWorkspace();
  }, [initWorkspace]);

  // Sync the keep-awake pref to the backend (HOY-188). Runs on mount so the
  // persisted choice reaches the Rust owner thread (whose default is on), and
  // again whenever the user toggles it.
  const keepAwakeWhileStreaming = usePrefsStore((s) => s.keepAwakeWhileStreaming);
  useEffect(() => {
    void setKeepAwake(keepAwakeWhileStreaming);
  }, [keepAwakeWhileStreaming]);

  const bodyRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => setBodyWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [setBodyWidth]);

  // When a panel is added beyond what fits, scroll the strip right so the new
  // rightmost panel is visible. A no-op when the panels still fit.
  const stripRef = useRef<HTMLDivElement>(null);
  // The footer's per-panel stats slices mirror the strip's horizontal scroll so
  // each slice stays under its panel (programmatic scrolls fire onScroll too).
  const footerSlicesRef = useRef<HTMLDivElement>(null);
  const panelCount = useRef(panels.length);
  useEffect(() => {
    if (panels.length > panelCount.current && stripRef.current) {
      stripRef.current.scrollLeft = stripRef.current.scrollWidth;
    }
    panelCount.current = panels.length;
  }, [panels.length]);

  // Re-sync the slices when panels change without a scroll event: closing
  // panels makes both containers clamp scrollLeft independently (to different
  // values), and a footer remount starts at 0 while the strip keeps its offset.
  useLayoutEffect(() => {
    const strip = stripRef.current;
    const el = footerSlicesRef.current;
    if (strip && el) el.scrollLeft = strip.scrollLeft;
  }, [panels]);

  const [debug, setDebug] = useState<PiState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const id = await activeSessionId();
        if (cancelled) return;
        setActiveSessionId(id);

        // Provider/auth/model hydration is owned by refreshProviderData; the
        // providers and statuses are sessionless, so it runs with no session
        // too (first-key setup). Only getState needs the session.
        const [piState] = await Promise.all([
          id ? getState(id) : Promise.resolve(null),
          refreshProviderData(),
        ]);
        if (cancelled) return;
        // The control session's model is Pi's persisted defaultModel: what a
        // thread shows and spawns with until it has its own pick.
        if (piState?.model) {
          setDefaultModel({
            provider: piState.model.provider,
            id: piState.model.id,
          });
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setActiveSessionId, setDefaultModel]);

  // Developer round-trip: toggle the raw get_state payload in the transcript.
  async function handleDebug(sessionId?: string | null) {
    const targetId = sessionId ?? activeId;
    if (!targetId) {
      setError("No session available. The sidecar may have failed to spawn.");
      return;
    }
    if (debug) {
      setDebug(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setDebug(await getState(targetId));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const panelIsAgent = (panelId: string) => {
    const found = findThread(projects, panelId);
    if (!found) return false;
    return (
      isSubagentThread(found.thread) ||
      childThreadIdsOf(projects, panelId).length > 0
    );
  };

  return (
    <TooltipProvider delayDuration={200}>
      <SettingsModal />
      <ConfirmCloseDialog />
      <WindowResizeHandles />
      <div className="flex h-screen flex-col bg-background text-foreground">
        <div className="relative flex min-h-0 flex-1 overflow-hidden">
          {!sidebarCollapsed &&
            (sidebarView === "history" ? <ThreadHistory /> : <Sidebar />)}

          {/* Main column: the title bar spans the main body only (the sidebar
              keeps the top-left corner, Zed-style); panels render below it. */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <TitleBar />
            {/* Content row below the title bar: the panel area (bodyRef, which
                measures only the panels so their widths fit) and, to its right,
                the global tree dock (HOY-280) — a panel-independent sidebar that
                follows the active thread. */}
            <div className="flex min-h-0 flex-1 overflow-hidden">
            <div
              ref={bodyRef}
              className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden"
            >
              {bodyView === "usage" ? (
                <UsageView />
              ) : bodyView === "fleet" ? (
                <FleetBoard />
              ) : panels.length === 0 ? (
                <HomePage />
              ) : (
                <div
                  ref={stripRef}
                  onScroll={(e) => {
                    const el = footerSlicesRef.current;
                    if (el) el.scrollLeft = e.currentTarget.scrollLeft;
                  }}
                  className="flex min-h-0 flex-1 overflow-x-auto"
                >
                  {expandedPanel ? (
                    <div
                      onPointerDownCapture={() => focusPanel(expandedPanel.id)}
                      className={cn(
                        "flex min-h-0 flex-1 flex-col border-t-2",
                        panelIsAgent(expandedPanel.id)
                          ? expandedPanel.id === activeThreadId
                            ? "border-t-agent/80"
                            : "border-t-agent/40"
                          : expandedPanel.id === activeThreadId
                            ? "border-t-brand/70"
                            : "border-t-transparent",
                      )}
                    >
                      <ThreadView
                        threadId={expandedPanel.id}
                        active={expandedPanel.id === activeThreadId}
                        onClose={() =>
                          requestTeardown("close", expandedPanel.id)
                        }
                        onDebug={handleDebug}
                        busy={busy}
                        debug={debug}
                        error={error}
                      />
                    </div>
                  ) : (
                    <>
                      {panels.map((panel, i) => (
                        <Fragment key={panel.id}>
                          <div
                            style={{ width: panel.width }}
                            onPointerDownCapture={() => focusPanel(panel.id)}
                            className={cn(
                              "flex min-h-0 shrink-0 flex-col border-r border-t-2 border-r-border",
                              panelIsAgent(panel.id)
                                ? panel.id === activeThreadId
                                  ? "border-t-agent/80"
                                  : "border-t-agent/40"
                                : panel.id === activeThreadId
                                  ? "border-t-brand/70"
                                  : "border-t-transparent",
                            )}
                          >
                            <ThreadView
                              threadId={panel.id}
                              active={panel.id === activeThreadId}
                              onClose={() =>
                                requestTeardown("close", panel.id)
                              }
                              onDebug={handleDebug}
                              busy={busy}
                              debug={debug}
                              error={error}
                            />
                          </div>
                          {i < panels.length - 1 && (
                            <PanelResizeHandle index={i} />
                          )}
                        </Fragment>
                      ))}
                      {/* Unused workspace beside the panels: new panels dock here. */}
                      <div className="min-h-0 flex-1 bg-background" />
                    </>
                  )}
                </div>
              )}
            </div>
            {rightDock === "tree" && <TreeNavigator />}
            </div>
          </div>
        </div>
        <ContextBar slicesRef={footerSlicesRef} />
      </div>
      <ForkPicker />
    </TooltipProvider>
  );
}

// Drag the divider on a panel's right edge. Reports the pointer delta since the
// last move to the store, which borrows from the neighbor (growing past its
// minimum scrolls the strip).
function PanelResizeHandle({ index }: { index: number }) {
  const resizePanelEdge = useSessionStore((s) => s.resizePanelEdge);
  const lastX = useRef(0);
  const onMove = useCallback(
    (ev: PointerEvent) => {
      const dx = ev.clientX - lastX.current;
      lastX.current = ev.clientX;
      if (dx !== 0) resizePanelEdge(index, dx);
    },
    [index, resizePanelEdge],
  );
  const { dragging, startDrag } = useGlobalDrag(onMove);

  // Zero-width in flow (the panel's border-r is the visible divider) with an
  // absolutely positioned drag strip straddling the seam, so the handle never
  // adds layout width and can't push a spurious horizontal scroll.
  return (
    <div className="relative z-20 w-0 shrink-0">
      <div
        onPointerDown={(e) => {
          e.preventDefault();
          lastX.current = e.clientX;
          startDrag();
        }}
        role="separator"
        aria-orientation="vertical"
        className="group/resize absolute inset-y-0 -left-1 w-2 cursor-col-resize"
      >
        <span
          className={cn(
            "absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors",
            dragging
              ? "bg-ring"
              : "bg-transparent group-hover/resize:bg-ring/60",
          )}
        />
      </div>
    </div>
  );
}

export default App;
