import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { removeProviderKey, saveProviderKey } from "@/lib/ipc";
import { refreshProviderData } from "@/lib/refresh";
import { useSessionStore } from "@/state/store";
import { cn } from "@/lib/utils";
import type { ProviderAuth, ProviderInfo } from "@/lib/types";
import { PanelHeader, Section, StatusDot } from "./panels";
import {
  OAUTH_PROVIDERS,
  metaFor,
  partitionProviders,
} from "./providerMeta";

function statusLabel(auth: ProviderAuth): string {
  if (auth.source === "environment") return "Connected, env var";
  if (auth.kind === "oauth") return "Connected, login";
  return "Connected, saved key";
}

function ConnectAccountSection() {
  return (
    <Section
      title="Connect an account"
      description="Sign in with a subscription instead of an API key."
    >
      <ul className="mt-4 divide-y divide-border">
        {OAUTH_PROVIDERS.map((p) => (
          <li
            key={p.id}
            className="flex items-center justify-between gap-3 py-3 opacity-60"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{p.label}</p>
              <p className="text-xs text-muted-foreground">{p.description}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Badge variant="secondary" className="text-muted-foreground">
                Coming soon
              </Badge>
              <Button variant="outline" size="sm" disabled>
                Connect
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function ProviderRow({
  info,
  auth,
  expanded,
  onToggle,
  onClose,
  onChanged,
}: {
  info: ProviderInfo;
  auth: ProviderAuth | undefined;
  expanded: boolean;
  onToggle: () => void;
  // Collapses this row only if it is still the expanded one; a plain toggle
  // here would re-expand the row (or steal expansion from another row) when
  // the user changed expansion while the save was in flight.
  onClose: () => void;
  // Never rejects; refresh failures surface panel-level so a row error always
  // means the save/remove itself failed.
  onChanged: () => Promise<void>;
}) {
  const meta = metaFor(info.id, info.label);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await onChanged();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleSave() {
    if (busy || !key.trim()) return;
    await run(async () => {
      await saveProviderKey(info.id, key.trim());
      setKey("");
    });
  }

  async function handleRemove() {
    if (busy) return;
    await run(() => removeProviderKey(info.id));
  }

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-accent/40"
      >
        <div className="flex min-w-0 items-center gap-2">
          <ChevronRight
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-90",
            )}
          />
          <span className="truncate text-sm font-medium">{info.label}</span>
        </div>
        {auth?.configured && (
          <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
            <StatusDot />
            {statusLabel(auth)}
          </span>
        )}
      </button>

      {expanded && (
        <div className="space-y-3 px-4 pb-4 pl-10">
          <p className="text-sm text-muted-foreground">{meta.description}</p>
          <ol className="list-decimal space-y-1 pl-4 text-sm text-muted-foreground">
            {meta.consoleUrl && (
              <li>
                Get your API key from{" "}
                <button
                  type="button"
                  onClick={() => void openUrl(meta.consoleUrl!)}
                  className="text-foreground underline underline-offset-2 hover:text-brand"
                >
                  {meta.consoleLabel ?? new URL(meta.consoleUrl).hostname}
                </button>
              </li>
            )}
            <li>Paste it below and press Enter</li>
          </ol>
          <div className="flex items-center gap-2">
            <Input
              type="password"
              value={key}
              placeholder={meta.placeholder}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleSave();
              }}
            />
            <Button
              size="sm"
              disabled={busy || !key.trim()}
              onClick={() => void handleSave()}
            >
              Save
            </Button>
          </div>
          {auth?.kind === "oauth" && (
            <p className="text-xs text-amber-500">
              Saving a key replaces the existing login for this provider.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            You can also set{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
              {info.env}
            </code>{" "}
            in the environment and restart Hoy.
          </p>
          {error && <p className="text-xs text-destructive">{error}</p>}
          {auth?.removable && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void handleRemove()}
              className="text-muted-foreground hover:text-destructive"
            >
              Remove
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export function ProvidersPanel() {
  const supported = useSessionStore((s) => s.supportedProviders);
  const providerAuth = useSessionStore((s) => s.providerAuth);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Catches into panel-level state instead of rejecting: rows await this as
  // onChanged after a successful save/remove, and a refresh failure must not
  // masquerade as a failed save.
  const refresh = useCallback(async () => {
    try {
      await refreshProviderData();
      setLoadError(null);
    } catch (e) {
      setLoadError(String(e));
    }
  }, []);

  // Cheap; picks up the no-session boot path.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const authOf = useMemo(() => {
    const map = new Map(providerAuth.map((a) => [a.provider, a]));
    return (id: string) => map.get(id);
  }, [providerAuth]);

  const { configured, featured, rest } = useMemo(
    () => partitionProviders(supported, providerAuth),
    [supported, providerAuth],
  );

  const row = (info: ProviderInfo) => (
    <ProviderRow
      key={info.id}
      info={info}
      auth={authOf(info.id)}
      expanded={expandedId === info.id}
      onToggle={() =>
        setExpandedId((cur) => (cur === info.id ? null : info.id))
      }
      onClose={() => setExpandedId((cur) => (cur === info.id ? null : cur))}
      onChanged={refresh}
    />
  );

  return (
    <div className="space-y-8">
      <PanelHeader
        title="Providers"
        description="Connect a model provider to start chatting. Keys are stored locally and never shown again."
      />
      {loadError && <p className="text-xs text-destructive">{loadError}</p>}

      <ConnectAccountSection />

      <div className="divide-y divide-border rounded-lg border border-border">
        {configured.map(row)}
        {configured.length > 0 && (
          <div className="bg-muted/30 px-4 py-1.5 text-xs text-muted-foreground">
            All providers
          </div>
        )}
        {featured.map(row)}
        <Collapsible open={showAll} onOpenChange={setShowAll}>
          <CollapsibleTrigger className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm text-muted-foreground hover:bg-accent/40">
            <ChevronRight
              className={cn(
                "size-4 shrink-0 transition-transform",
                showAll && "rotate-90",
              )}
            />
            {showAll ? "Hide" : `Show all providers (${rest.length})`}
          </CollapsibleTrigger>
          <CollapsibleContent className="divide-y divide-border border-t border-border">
            {rest.map(row)}
          </CollapsibleContent>
        </Collapsible>
      </div>
    </div>
  );
}
