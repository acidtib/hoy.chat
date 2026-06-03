import { useCallback, useEffect, useState } from "react";
import { Sidebar } from "@/components/Sidebar";
import { TopBar } from "@/components/TopBar";
import { Transcript } from "@/components/Transcript";
import { Composer } from "@/components/Composer";
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

type View = "chat" | "settings";

function App() {
  const sessions = useSessionStore((s) => s.sessions);
  const activeId = useSessionStore((s) => s.activeSessionId);
  const models = useSessionStore((s) => s.models);
  const setSessions = useSessionStore((s) => s.setSessions);
  const setActiveSessionId = useSessionStore((s) => s.setActiveSessionId);
  const setModels = useSessionStore((s) => s.setModels);
  const setSupportedProviders = useSessionStore((s) => s.setSupportedProviders);
  const setProviderAuth = useSessionStore((s) => s.setProviderAuth);

  const [state, setState] = useState<PiState | null>(null);
  const [debug, setDebug] = useState<PiState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [view, setView] = useState<View>("chat");

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
        setSessions(id ? [{ id, title: "Session 1" }] : []);
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
  }, [setActiveSessionId, setSessions, setModels, setSupportedProviders, refreshAuth]);

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

  if (view === "settings") {
    return (
      <TooltipProvider delayDuration={200}>
        <SettingsPage onBack={() => setView("chat")} onConfigured={handleConfigured} />
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-screen flex-col bg-background text-foreground">
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <Sidebar sessions={sessions} activeId={activeId} />
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <TopBar
              models={models}
              currentModel={state?.model}
              selecting={selecting}
              onSelectModel={handleSelectModel}
              onOpenSettings={() => setView("settings")}
              onDebug={handleDebug}
              busy={busy}
            />
            <Transcript debug={debug} error={error} />
            <Composer />
          </div>
        </div>
        <ContextBar state={state} />
      </div>
    </TooltipProvider>
  );
}

export default App;
