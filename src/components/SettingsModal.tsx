import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { providerOptions, useSessionStore } from "@/state/store";
import type { ProviderAuth } from "@/lib/types";

function statusLabel(status?: ProviderAuth): string {
  if (!status?.configured) return "Not set";
  if (status.source === "environment") return "Configured (env)";
  if (status.kind === "oauth") return "Configured (login)";
  return "Configured (key)";
}

export function SettingsModal({
  open,
  onOpenChange,
  onConfigured,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfigured: () => void | Promise<void>;
}) {
  const models = useSessionStore((s) => s.models);
  const known = useSessionStore((s) => s.knownProviders);
  const providerAuth = useSessionStore((s) => s.providerAuth);
  const providers = providerOptions(known, models);

  const [provider, setProvider] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedProvider = provider || providers[0] || "";

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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Provider settings</DialogTitle>
          <DialogDescription>
            Keys are written to Pi's auth.json (mode 0600) and never displayed again.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="provider">Provider</Label>
            <Select value={selectedProvider} onValueChange={setProvider}>
              <SelectTrigger id="provider" className="w-full">
                <SelectValue placeholder="Select provider" />
              </SelectTrigger>
              <SelectContent>
                {providers.map((p) => (
                  <SelectItem key={p} value={p} className="capitalize">
                    {p}
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

          <div className="space-y-2 border-t border-border pt-4">
            <p className="text-sm font-medium text-muted-foreground">
              Configured providers
            </p>
            <ul className="space-y-1">
              {providers.map((p) => {
                const status = providerAuth.find((a) => a.provider === p);
                return (
                  <li
                    key={p}
                    className="flex items-center justify-between text-sm"
                  >
                    <span className="capitalize">{p}</span>
                    <div className="flex items-center gap-2">
                      <span
                        className={
                          status?.configured
                            ? "text-emerald-500"
                            : "text-muted-foreground"
                        }
                      >
                        {statusLabel(status)}
                      </span>
                      {status?.removable && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => handleRemove(p)}
                        >
                          Remove
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
