import { useCallback, useEffect, useState } from "react";
import { Sidebar } from "@/components/Sidebar";
import { TopBar } from "@/components/TopBar";
import { Transcript } from "@/components/Transcript";
import { Composer } from "@/components/Composer";
import { ContextBar } from "@/components/ContextBar";
import { SettingsModal } from "@/components/SettingsModal";
import {
  activeSessionId,
  getState,
  knownProviders,
  listModels,
  providerStatuses,
  setModel,
} from "@/lib/ipc";
import { providerOptions, useSessionStore } from "@/state/store";
import type { PiState } from "@/lib/types";

function App() {
  const sessions = useSessionStore((s) => s.sessions);
  const activeId = useSessionStore((s) => s.activeSessionId);
  const models = useSessionStore((s) => s.models);
  const setSessions = useSessionStore((s) => s.setSessions);
  const setActiveSessionId = useSessionStore((s) => s.setActiveSessionId);
  const setModels = useSessionStore((s) => s.setModels);
  const setKnownProviders = useSessionStore((s) => s.setKnownProviders);
  const setProviderAuth = useSessionStore((s) => s.setProviderAuth);

  const [state, setState] = useState<PiState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const refreshAuth = useCallback(async () => {
    const { knownProviders: known, models } = useSessionStore.getState();
    const providers = providerOptions(known, models);
    if (providers.length === 0) return;
    try {
      setProviderAuth(await providerStatuses(providers));
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

        const [piState, modelList, known] = await Promise.all([
          getState(id),
          listModels(),
          knownProviders(),
        ]);
        if (cancelled) return;
        setState(piState);
        setModels(modelList);
        setKnownProviders(known);
        await refreshAuth();
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setActiveSessionId, setSessions, setModels, setKnownProviders, refreshAuth]);

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
  // state and configured status. Models are unchanged so we keep the cached list.
  const handleConfigured = useCallback(async () => {
    await refreshAuth();
    if (activeId) {
      try {
        setState(await getState(activeId));
      } catch (e) {
        setError(String(e));
      }
    }
  }, [activeId, refreshAuth]);

  async function handleDebug() {
    if (!activeId) {
      setError("No active session. The sidecar may have failed to spawn.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setState(await getState(activeId));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <div className="flex flex-1 overflow-hidden">
        <Sidebar sessions={sessions} activeId={activeId} />
        <div className="flex flex-1 flex-col overflow-hidden">
          <TopBar
            models={models}
            currentModel={state?.model}
            selecting={selecting}
            onSelectModel={handleSelectModel}
            onOpenSettings={() => setSettingsOpen(true)}
            onDebug={handleDebug}
            busy={busy}
          />
          <Transcript state={state} error={error} />
          <Composer />
        </div>
      </div>
      <ContextBar state={state} />
      <SettingsModal
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onConfigured={handleConfigured}
      />
    </div>
  );
}

export default App;
