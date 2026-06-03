import { useMemo, useState } from "react";
import { ArrowLeft } from "lucide-react";
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
import { removeProviderKey, saveProviderKey } from "@/lib/ipc";
import { useSessionStore } from "@/state/store";
import type { ProviderAuth } from "@/lib/types";

function statusLabel(status: ProviderAuth): string {
  if (status.source === "environment") return "Configured (env)";
  if (status.kind === "oauth") return "Configured (login)";
  return "Configured (key)";
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
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back">
          <ArrowLeft className="size-4" />
        </Button>
        <span className="text-sm font-medium">Settings</span>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-xl space-y-8 px-6 py-8">
          <section className="space-y-4">
            <div>
              <h2 className="text-sm font-semibold">Add a provider key</h2>
              <p className="text-sm text-muted-foreground">
                The key is written to Pi's auth.json (mode 0600) and never displayed
                again. Anthropic and OpenAI also support subscription login via{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-xs">pi login</code>{" "}
                in a terminal.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="provider">Provider</Label>
              <Select value={selectedProvider} onValueChange={setProvider}>
                <SelectTrigger id="provider" className="w-full">
                  <SelectValue placeholder="Select provider" />
                </SelectTrigger>
                <SelectContent className="max-h-[50vh]">
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
              />
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <div className="flex justify-end">
              <Button onClick={handleSave} disabled={busy || !key.trim()}>
                {busy ? "Saving..." : "Save key"}
              </Button>
            </div>
          </section>

          <section className="space-y-3 border-t border-border pt-6">
            <h2 className="text-sm font-semibold">Configured providers</h2>
            {configured.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No providers configured yet.
              </p>
            ) : (
              <ul className="space-y-2">
                {configured.map((a) => (
                  <li
                    key={a.provider}
                    className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm"
                  >
                    <span>{labelOf(a.provider)}</span>
                    <div className="flex items-center gap-3">
                      <span className="text-emerald-500">{statusLabel(a)}</span>
                      {a.removable && (
                        <Button
                          variant="ghost"
                          size="sm"
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
