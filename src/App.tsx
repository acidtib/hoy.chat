import { useEffect, useState } from "react";
import { Sidebar } from "@/components/Sidebar";
import { TopBar } from "@/components/TopBar";
import { Transcript } from "@/components/Transcript";
import { Composer } from "@/components/Composer";
import { ContextBar } from "@/components/ContextBar";
import { activeSessionId, getState } from "@/lib/ipc";
import { useSessionStore } from "@/state/store";
import type { PiState } from "@/lib/types";

function App() {
  const sessions = useSessionStore((s) => s.sessions);
  const activeId = useSessionStore((s) => s.activeSessionId);
  const setSessions = useSessionStore((s) => s.setSessions);
  const setActiveSessionId = useSessionStore((s) => s.setActiveSessionId);

  const [state, setState] = useState<PiState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    activeSessionId()
      .then((id) => {
        setActiveSessionId(id);
        setSessions(id ? [{ id, title: "Session 1" }] : []);
      })
      .catch((e) => setError(String(e)));
  }, [setActiveSessionId, setSessions]);

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
          <TopBar model={state?.model} onDebug={handleDebug} busy={busy} />
          <Transcript state={state} error={error} />
          <Composer />
        </div>
      </div>
      <ContextBar state={state} />
    </div>
  );
}

export default App;
