import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLinearStore } from "@/state/linear";
import { PanelHeader, Section, StatusDot } from "./panels";

export function IntegrationsPanel() {
  return (
    <div className="space-y-8">
      <PanelHeader
        title="Integrations"
        description="Task sources whose work you can hand to agents from a project's Fleet."
      />
      <LinearSection />
    </div>
  );
}

function LinearSection() {
  const status = useLinearStore((s) => s.status);
  const refreshStatus = useLinearStore((s) => s.refreshStatus);
  const connect = useLinearStore((s) => s.connect);
  const connectOAuth = useLinearStore((s) => s.connectOAuth);
  const cancelOAuth = useLinearStore((s) => s.cancelOAuth);
  const disconnect = useLinearStore((s) => s.disconnect);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setKey("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const connected = !!status?.connected;
  const oauth = !!status?.oauthAvailable;

  async function signIn() {
    setSigningIn(true);
    setError(null);
    try {
      await connectOAuth();
    } catch (e) {
      const message = String(e);
      if (!message.includes("cancelled")) setError(message);
    } finally {
      setSigningIn(false);
    }
  }

  return (
    <Section
      title="Linear"
      description="Link a project to a Linear team and its backlog and Todo issues show up in the project's Fleet."
      action={
        connected && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void run(disconnect)}
          >
            Disconnect
          </Button>
        )
      }
    >
      <div className="mt-4 space-y-3">
        {connected ? (
          <div className="flex items-center gap-2 text-sm">
            <StatusDot on={!status?.error} />
            {status?.error ? (
              <span className="text-destructive">{status.error}</span>
            ) : (
              <span>
                Connected
                {status?.method === "apiKey" && " with an API key"}
                {status?.organization && (
                  <span className="text-muted-foreground">
                    {" "}
                    to {status.organization}
                    {status.viewerName && ` as ${status.viewerName}`}
                  </span>
                )}
              </span>
            )}
          </div>
        ) : (
          <>
            {oauth && (
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  disabled={signingIn || busy}
                  onClick={() => void signIn()}
                >
                  {signingIn
                    ? "Waiting for the browser..."
                    : "Sign in with Linear"}
                </Button>
                {signingIn && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void cancelOAuth()}
                  >
                    Cancel
                  </Button>
                )}
                {!signingIn && (
                  <Button
                    variant="link"
                    size="sm"
                    className="ml-auto text-muted-foreground"
                    onClick={() => setShowKey((v) => !v)}
                  >
                    {showKey ? "Hide API key option" : "Use an API key instead"}
                  </Button>
                )}
              </div>
            )}
            {(!oauth || showKey) && (
              <form
                className="flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (key.trim()) void run(() => connect(key));
                }}
              >
                <Input
                  type="password"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder="lin_api_..."
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="Linear API key"
                />
                <Button type="submit" size="sm" disabled={busy || !key.trim()}>
                  {busy ? "Connecting..." : "Connect"}
                </Button>
              </form>
            )}
          </>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
        {!connected && signingIn && (
          <p className="text-xs text-muted-foreground">
            Approve Hoy in the browser tab that just opened, then come back
            here.
          </p>
        )}
        {!connected && (!oauth || showKey) && (
          <p className="text-xs text-muted-foreground">
            Create a personal API key in Linear under Settings, Security &amp;
            access, Personal API keys. Hoy stores it in its own config directory
            and never shows it again.
          </p>
        )}
      </div>
    </Section>
  );
}
