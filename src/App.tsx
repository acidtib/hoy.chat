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
import { HomePage } from "@/components/HomePage";
import { ThreadView } from "@/components/ThreadView";
import { ContextBar } from "@/components/ContextBar";
import { SettingsPage } from "@/components/SettingsPage";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  activeSessionId,
  getState,
  listModels,
  providerStatuses,
  setModel,
  supportedProviders,
} from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useGlobalDrag } from "@/lib/useGlobalDrag";
import { useSessionStore } from "@/state/store";
import type { PiState } from "@/lib/types";

function App() {
  const panels = useSessionStore((s) => s.panels);
  const activeThreadId = useSessionStore((s) => s.activeThreadId);
  const sidebarCollapsed = useSessionStore((s) => s.sidebarCollapsed);
  const sidebarView = useSessionStore((s) => s.sidebarView);
  const initWorkspace = useSessionStore((s) => s.initWorkspace);
  const activeId = useSessionStore((s) => s.activeSessionId);
  const models = useSessionStore((s) => s.models);
  const setBodyWidth = useSessionStore((s) => s.setBodyWidth);
  const closePanel = useSessionStore((s) => s.closePanel);
  const focusPanel = useSessionStore((s) => s.openThread);
  const setActiveSessionId = useSessionStore((s) => s.setActiveSessionId);
  const setModels = useSessionStore((s) => s.setModels);
  const setSupportedProviders = useSessionStore((s) => s.setSupportedProviders);
  const setProviderAuth = useSessionStore((s) => s.setProviderAuth);

  // Restore the persisted projects -> threads tree on boot (then autosave kicks in).
  useEffect(() => {
    void initWorkspace();
  }, [initWorkspace]);

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
  const panelCount = useRef(panels.length);
  useEffect(() => {
    if (panels.length > panelCount.current && stripRef.current) {
      stripRef.current.scrollLeft = stripRef.current.scrollWidth;
    }
    panelCount.current = panels.length;
  }, [panels.length]);

  const [state, setState] = useState<PiState | null>(null);
  const [debug, setDebug] = useState<PiState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const refreshAuth = useCallback(async () => {
    const providers = useSessionStore.getState().supportedProviders;
    if (providers.length === 0) return;
    try {
      setProviderAuth(await providerStatuses(providers.map((p) => p.id)));
    } catch (e) {
      setError(String(e));
    }
  }, [setProviderAuth]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const id = await activeSessionId();
        if (cancelled) return;
        setActiveSessionId(id);
        if (!id) return;

        const [piState, modelList, providers] = await Promise.all([
          getState(id),
          listModels(),
          supportedProviders(),
        ]);
        if (cancelled) return;
        setState(piState);
        setModels(modelList);
        setSupportedProviders(providers);
        await refreshAuth();
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setActiveSessionId, setModels, setSupportedProviders, refreshAuth]);

  async function handleSelectModel(provider: string, modelId: string) {
    if (!activeId) return;
    setSelecting(true);
    setError(null);
    try {
      await setModel(activeId, provider, modelId);
      setState(await getState(activeId));
    } catch (e) {
      setError(String(e));
    } finally {
      setSelecting(false);
    }
  }

  // After a key is saved or removed the sidecar was respawned in Rust; re-read
  // state and configured status. Models may change (a newly configured provider
  // surfaces its catalog), so refresh them too.
  const handleConfigured = useCallback(async () => {
    const id = useSessionStore.getState().activeSessionId;
    try {
      if (id) {
        const [piState, modelList] = await Promise.all([getState(id), listModels()]);
        setState(piState);
        setModels(modelList);
      }
      await refreshAuth();
    } catch (e) {
      setError(String(e));
    }
  }, [setModels, refreshAuth]);

  // Developer round-trip: toggle the raw get_state payload in the transcript.
  async function handleDebug() {
    if (!activeId) {
      setError("No active session. The sidecar may have failed to spawn.");
      return;
    }
    if (debug) {
      setDebug(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const s = await getState(activeId);
      setState(s);
      setDebug(s);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (settingsOpen) {
    return (
      <TooltipProvider delayDuration={200}>
        <SettingsPage
          onBack={() => setSettingsOpen(false)}
          onConfigured={handleConfigured}
        />
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-screen flex-col bg-background text-foreground">
        <div className="relative flex min-h-0 flex-1 overflow-hidden">
          {!sidebarCollapsed &&
            (sidebarView === "history" ? <ThreadHistory /> : <Sidebar />)}

          <div ref={bodyRef} className="relative flex min-h-0 flex-1 overflow-hidden">
            {panels.length === 0 ? (
              <HomePage onOpenSettings={() => setSettingsOpen(true)} />
            ) : (
              <div ref={stripRef} className="flex min-h-0 flex-1 overflow-x-auto">
                {panels.map((panel, i) => (
                  <Fragment key={panel.id}>
                    <div
                      style={{ width: panel.width }}
                      onPointerDownCapture={() => focusPanel(panel.id)}
                      className={cn(
                        "flex min-h-0 shrink-0 flex-col border-r border-t-2 border-r-border",
                        panel.id === activeThreadId
                          ? "border-t-brand/70"
                          : "border-t-transparent",
                      )}
                    >
                      <ThreadView
                        threadId={panel.id}
                        active={panel.id === activeThreadId}
                        onClose={() => closePanel(panel.id)}
                        models={models}
                        currentModel={state?.model}
                        selecting={selecting}
                        onSelectModel={handleSelectModel}
                        onOpenSettings={() => setSettingsOpen(true)}
                        onDebug={handleDebug}
                        busy={busy}
                        debug={debug}
                        error={error}
                      />
                    </div>
                    {i < panels.length - 1 && <PanelResizeHandle index={i} />}
                  </Fragment>
                ))}
                {/* Unused workspace beside the panels: new panels dock here. */}
                <div className="min-h-0 flex-1 bg-background" />
              </div>
            )}
          </div>
        </div>
        <ContextBar state={state} />
      </div>
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
