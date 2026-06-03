import { useMemo, useState } from "react";
import { AlertCircle, ArrowLeft, KeyRound } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { removeProviderKey, saveProviderKey } from "@/lib/ipc";
import { useSessionStore } from "@/state/store";
import type { ProviderAuth } from "@/lib/types";

function statusLabel(status: ProviderAuth): string {
  if (status.source === "environment") return "Environment";
  if (status.kind === "oauth") return "Login";
  return "API key";
}

export function SettingsPage({
  onBack,
  onConfigured,
}: {
  onBack: () => void;
  onConfigured: () => void | Promise<void>;
}) {
  const supported = useSessionStore((s) => s.supportedProviders);
  const providerAuth = useSessionStore((s) => s.providerAuth);

  const labelOf = useMemo(() => {
    const map = new Map(supported.map((p) => [p.id, p.label]));
    return (id: string) => map.get(id) ?? id;
  }, [supported]);

  const configured = providerAuth.filter((a) => a.configured);

  const [provider, setProvider] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedProvider = provider || supported[0]?.id || "";

  async function handleSave() {
    if (!selectedProvider || !key.trim()) {
      setError("Choose a provider and paste a key.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await saveProviderKey(selectedProvider, key.trim());
      setKey("");
      await onConfigured();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(p: string) {
    setBusy(true);
    setError(null);
    try {
      await removeProviderKey(p);
      await onConfigured();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background/60 px-4 backdrop-blur-sm">
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground"
          onClick={onBack}
          aria-label="Back"
        >
          <ArrowLeft className="size-4" />
        </Button>
        <span className="text-sm font-semibold">Settings</span>
      </header>

      <div className="scrollbar-thin flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl space-y-10 px-6 py-10">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Providers</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Connect a model provider to start chatting with Pi.
            </p>
          </div>

          <section className="rounded-2xl border border-border bg-card/50 p-5">
            <div className="flex items-center gap-2.5">
              <div className="flex size-8 items-center justify-center rounded-lg bg-brand/10 text-brand ring-1 ring-inset ring-brand/20">
                <KeyRound className="size-4" />
              </div>
              <div>
                <h2 className="text-sm font-semibold">Add a provider key</h2>
                <p className="text-xs text-muted-foreground">
                  Stored in Pi's auth.json (mode 0600), never shown again.
                </p>
              </div>
            </div>

            <div className="mt-5 grid gap-4 sm:grid-cols-[180px_1fr]">
              <div className="space-y-2">
                <Label htmlFor="provider">Provider</Label>
                <Select value={selectedProvider} onValueChange={setProvider}>
                  <SelectTrigger id="provider" className="w-full">
                    <SelectValue placeholder="Select provider" />
                  </SelectTrigger>
                  <SelectContent className="scrollbar-thin max-h-[50vh]">
                    {supported.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="apikey">API key</Label>
                <Input
                  id="apikey"
                  type="password"
                  placeholder="Paste API key"
                  value={key}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setKey(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && key.trim() && !busy) handleSave();
                  }}
                />
              </div>
            </div>

            <p className="mt-3 text-xs text-muted-foreground">
              Anthropic and OpenAI also support subscription login via{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                pi login
              </code>{" "}
              in a terminal.
            </p>

            {error && (
              <div className="mt-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <div className="mt-5 flex justify-end">
              <Button onClick={handleSave} disabled={busy || !key.trim()}>
                {busy ? "Saving..." : "Save key"}
              </Button>
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-semibold">Configured providers</h2>
            {configured.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
                No providers configured yet.
              </div>
            ) : (
              <ul className="space-y-2">
                {configured.map((a) => (
                  <li
                    key={a.provider}
                    className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card/50 px-4 py-3"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <span
                        className="size-2 shrink-0 rounded-full bg-emerald-500 shadow-[0_0_0_3px] shadow-emerald-500/15"
                        aria-hidden
                      />
                      <span className="truncate text-sm font-medium">
                        {labelOf(a.provider)}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge variant="outline" className="text-muted-foreground">
                        {statusLabel(a)}
                      </Badge>
                      {a.removable && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className={cn("text-muted-foreground hover:text-destructive")}
                          disabled={busy}
                          onClick={() => handleRemove(a.provider)}
                        >
                          Remove
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
