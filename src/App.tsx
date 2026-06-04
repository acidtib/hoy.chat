import { useCallback, useEffect, useState } from "react";
import { Sidebar } from "@/components/Sidebar";
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
import { useSessionStore } from "@/state/store";
import type { PiState } from "@/lib/types";

function App() {
  const activeThreadId = useSessionStore((s) => s.activeThreadId);
  const sidebarCollapsed = useSessionStore((s) => s.sidebarCollapsed);
  const activeId = useSessionStore((s) => s.activeSessionId);
  const models = useSessionStore((s) => s.models);
  const setActiveSessionId = useSessionStore((s) => s.setActiveSessionId);
  const setModels = useSessionStore((s) => s.setModels);
  const setSupportedProviders = useSessionStore((s) => s.setSupportedProviders);
  const setProviderAuth = useSessionStore((s) => s.setProviderAuth);

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
          {!sidebarCollapsed && <Sidebar />}

          {activeThreadId === null ? (
            <HomePage onOpenSettings={() => setSettingsOpen(true)} />
          ) : (
            <div className="flex min-h-0 flex-1 overflow-hidden">
              <div className="flex min-h-0 w-[660px] shrink-0 flex-col border-r border-border">
                <ThreadView
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
              {/* Empty workspace beside the panel: where more agent panels or an
                  editor will dock, mirroring Zed's multi-panel layout. */}
              <div className="min-h-0 flex-1 bg-background" />
            </div>
          )}
        </div>
        <ContextBar state={state} />
      </div>
    </TooltipProvider>
  );
}

export default App;
