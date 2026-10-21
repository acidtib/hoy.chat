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
  const disconnect = useLinearStore((s) => s.disconnect);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const workspaces = status?.workspaces ?? [];
  const connected = workspaces.length > 0;

  async function remove(id: string) {
    setBusy(id);
    setError(null);
    try {
      await disconnect(id || undefined);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Section
      title="Linear"
      description="Link a project to a Linear team and its backlog and Todo issues show up in the project's Fleet. Connect every workspace your projects use."
      action={
        connected &&
        !adding && (
          <Button variant="outline" size="sm" className="cursor-pointer" onClick={() => setAdding(true)}>
            Add another workspace
          </Button>
        )
      }
    >
      <div className="mt-4 space-y-3">
        {connected && (
          <ul className="divide-y divide-border border border-border">
            {workspaces.map((w) => (
              <li key={w.id || "legacy"} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                <StatusDot on={!w.error} />
                <div className="min-w-0 flex-1">
                  <p className="truncate">{w.name || "Linear workspace"}</p>
                  <p className={w.error ? "truncate text-xs text-destructive" : "truncate text-xs text-muted-foreground"}>
                    {w.error ??
                      [w.viewerName && `as ${w.viewerName}`, w.method === "apiKey" ? "API key" : "signed in"]
                        .filter(Boolean)
                        .join(" · ")}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="cursor-pointer"
                  disabled={busy !== null}
                  onClick={() => void remove(w.id)}
                >
                  {busy === w.id ? "Disconnecting..." : "Disconnect"}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {(!connected || adding) && (
          <LinearConnect
            oauth={!!status?.oauthAvailable}
            hint={
              connected
                ? "Linear asks which workspace to authorize. Pick the one you want to add; signing in to one already listed refreshes it."
                : null
            }
            onDone={() => setAdding(false)}
            onCancel={connected ? () => setAdding(false) : undefined}
          />
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    </Section>
  );
}

// Sign in with Linear (OAuth) or paste a personal API key. Each success adds a
// workspace, or refreshes the credential of one already connected.
function LinearConnect({
  oauth,
  hint,
  onDone,
  onCancel,
}: {
  oauth: boolean;
  hint: string | null;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const connect = useLinearStore((s) => s.connect);
  const connectOAuth = useLinearStore((s) => s.connectOAuth);
  const cancelOAuth = useLinearStore((s) => s.cancelOAuth);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function withKey() {
    setBusy(true);
    setError(null);
    try {
      await connect(key);
      setKey("");
      onDone();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function signIn() {
    setSigningIn(true);
    setError(null);
    try {
      await connectOAuth();
      onDone();
    } catch (e) {
      const message = String(e);
      if (!message.includes("cancelled")) setError(message);
    } finally {
      setSigningIn(false);
    }
  }

  return (
    <div className="space-y-3">
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {oauth && (
        <div className="flex items-center gap-2">
          <Button size="sm" className="cursor-pointer" disabled={signingIn || busy} onClick={() => void signIn()}>
            {signingIn ? "Waiting for the browser..." : "Sign in with Linear"}
          </Button>
          {signingIn && (
            <Button variant="ghost" size="sm" className="cursor-pointer" onClick={() => void cancelOAuth()}>
              Cancel
            </Button>
          )}
          {!signingIn && onCancel && (
            <Button variant="ghost" size="sm" className="cursor-pointer" onClick={onCancel}>
              Cancel
            </Button>
          )}
          {!signingIn && (
            <Button
              variant="link"
              size="sm"
              className="ml-auto cursor-pointer text-muted-foreground"
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
            if (key.trim()) void withKey();
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
          <Button type="submit" size="sm" className="cursor-pointer" disabled={busy || !key.trim()}>
            {busy ? "Connecting..." : "Connect"}
          </Button>
        </form>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      {signingIn && (
        <p className="text-xs text-muted-foreground">
          Approve Hoy in the browser tab that just opened, then come back here.
        </p>
      )}
      {(!oauth || showKey) && (
        <p className="text-xs text-muted-foreground">
          Create a personal API key in Linear under Settings, Security &amp; access, Personal API keys. Each key belongs to one workspace. Hoy stores it in its own config directory and never shows it again.
        </p>
      )}
    </div>
  );
}
