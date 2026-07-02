import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight, KeyRound, Search } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { refreshProviderData } from "@/lib/refresh";
import { useSessionStore } from "@/state/store";
import { cn } from "@/lib/utils";
import type { ProviderAuth, ProviderInfo } from "@/lib/types";
import { PanelHeader, Section } from "./panels";
import {
  SUBSCRIPTION_PROVIDERS,
  type SubscriptionProvider,
  initialsFor,
  metaFor,
  partitionProviders,
} from "./providerMeta";
import { ProviderGlyph, glyphSlugFor } from "./providerIcons";
import { OAuthLoginDialog } from "./OAuthLoginDialog";

function statusLabel(auth: ProviderAuth): string {
  if (auth.source === "environment") return "Env var";
  if (auth.kind === "oauth") return "Signed in";
  return "Saved key";
}

// Square mark tile: the provider's brand glyph in currentColor, or a two-letter
// monogram fallback for providers without a vendored mark. Neutral by default,
// brand-tinted once connected, so a scan down the list reads connected-ness at a
// glance without a second color per provider (the system is restrained to one
// brand hue; the glyphs are monochrome for the same reason).
function ProviderMark({
  label,
  providerId,
  slug,
  connected = false,
}: {
  label: string;
  providerId?: string;
  slug?: string;
  connected?: boolean;
}) {
  const resolved = slug ?? (providerId ? glyphSlugFor(providerId) : undefined);
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-9 shrink-0 select-none items-center justify-center border text-[11px] font-semibold tracking-wide",
        connected
          ? "border-brand/30 bg-brand/10 text-brand"
          : "border-border bg-muted/50 text-muted-foreground",
      )}
    >
      {resolved ? (
        <ProviderGlyph slug={resolved} className="size-[18px]" />
      ) : (
        initialsFor(label)
      )}
    </span>
  );
}

function StatusPill({ auth }: { auth: ProviderAuth }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
      <span
        className="size-1.5 rounded-full bg-emerald-500 shadow-[0_0_0_3px] shadow-emerald-500/15"
        aria-hidden
      />
      {statusLabel(auth)}
    </span>
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
  // Store actions, not the raw ipc: a key change respawns idle sidecars, and
  // the store must reset its per-session reconcile guards (HOY-196).
  const saveProviderKey = useSessionStore((s) => s.saveProviderKey);
  const removeProviderKey = useSessionStore((s) => s.removeProviderKey);
  const configured = Boolean(auth?.configured);

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
    <div className="group/row">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-accent/40"
      >
        <ProviderMark
          label={info.label}
          providerId={info.id}
          connected={configured}
        />
        <div className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">
            {info.label}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {meta.description}
          </span>
        </div>
        {configured && auth ? (
          <StatusPill auth={auth} />
        ) : (
          <span className="shrink-0 text-xs text-muted-foreground/60 transition-colors group-hover/row:text-muted-foreground">
            Add key
          </span>
        )}
        <ChevronRight
          className={cn(
            "size-4 shrink-0 text-muted-foreground/60 transition-transform",
            expanded && "rotate-90",
          )}
        />
      </button>

      {expanded && (
        <div className="animate-in fade-in-0 slide-in-from-top-1 space-y-3 border-t border-border/60 bg-muted/20 px-3 pb-4 pt-3 pl-[3.75rem] duration-150">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
            {meta.consoleUrl && (
              <>
                <span>Get a key from</span>
                <button
                  type="button"
                  onClick={() => void openUrl(meta.consoleUrl!)}
                  className="text-foreground underline underline-offset-2 hover:text-brand"
                >
                  {meta.consoleLabel ?? new URL(meta.consoleUrl).hostname}
                </button>
                <span>then paste it below.</span>
              </>
            )}
            {!meta.consoleUrl && <span>Paste an API key to connect.</span>}
          </div>
          <div className="flex items-center gap-2">
            <Input
              type="password"
              value={key}
              placeholder={meta.placeholder}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              autoFocus
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
              {configured ? "Replace" : "Save"}
            </Button>
          </div>
          {auth?.kind === "oauth" && (
            <p className="text-xs text-amber-500">
              Saving a key replaces the subscription login for this provider.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Or set{" "}
            <code className="rounded-none bg-muted px-1 py-0.5 font-mono text-[11px]">
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
              className="-ml-2 text-muted-foreground hover:text-destructive"
            >
              Remove key
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// Subscription sign-in. Reflects a real oauth entry in auth.json (a completed
// login shows "Signed in" with a Manage action); otherwise Connect launches the
// manual-paste OAuth flow (OAuthLoginDialog -> oauth_login_start).
function SubscriptionSection({
  authOf,
  onConnect,
}: {
  authOf: (id: string) => ProviderAuth | undefined;
  onConnect: (provider: SubscriptionProvider) => void;
}) {
  return (
    <div>
      <p className="px-1 text-xs font-medium text-muted-foreground">
        Use a subscription
      </p>
      <div className="mt-2 divide-y divide-border border border-border">
        {SUBSCRIPTION_PROVIDERS.map((p) => {
          const auth = authOf(p.id);
          const signedIn = Boolean(auth?.configured && auth.kind === "oauth");
          return (
            <div key={p.id} className="flex items-center gap-3 px-3 py-2.5">
              <ProviderMark
                label={p.label}
                slug={p.glyph}
                connected={signedIn}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{p.label}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {p.subtitle}
                </p>
              </div>
              {signedIn && auth ? (
                <div className="flex shrink-0 items-center gap-3">
                  <StatusPill auth={auth} />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground"
                    onClick={() => onConnect(p)}
                  >
                    Reconnect
                  </Button>
                </div>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onConnect(p)}
                >
                  Connect
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ProvidersPanel() {
  const supported = useSessionStore((s) => s.supportedProviders);
  const providerAuth = useSessionStore((s) => s.providerAuth);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loginProvider, setLoginProvider] = useState<SubscriptionProvider | null>(
    null,
  );

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

  const q = query.trim().toLowerCase();
  const searching = q.length > 0;
  const matches = useMemo(() => {
    if (!searching) return [];
    return supported
      .filter(
        (p) =>
          p.label.toLowerCase().includes(q) || p.id.toLowerCase().includes(q),
      )
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [supported, q, searching]);

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
        description="Connect a model provider to start chatting. Keys are stored locally in Hoy's agent directory and never shown again."
      />
      {loadError && (
        <Section>
          <p className="text-sm text-destructive">{loadError}</p>
        </Section>
      )}

      {!searching && (
        <SubscriptionSection authOf={authOf} onConnect={setLoginProvider} />
      )}

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <p className="px-1 text-xs font-medium text-muted-foreground">
            {searching
              ? `${matches.length} ${matches.length === 1 ? "provider" : "providers"}`
              : "API keys"}
          </p>
          <div className="relative w-56">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search providers"
              spellCheck={false}
              className="h-8 pl-8 text-sm"
              aria-label="Search providers"
            />
          </div>
        </div>

        {searching ? (
          matches.length > 0 ? (
            <div className="divide-y divide-border border border-border">
              {matches.map(row)}
            </div>
          ) : (
            <div className="border border-border px-4 py-10 text-center">
              <KeyRound className="mx-auto size-5 text-muted-foreground/50" />
              <p className="mt-2 text-sm text-muted-foreground">
                No providers match "{query.trim()}".
              </p>
            </div>
          )
        ) : (
          <div className="border border-border">
            {configured.length > 0 && (
              <>
                <p className="bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
                  Connected · {configured.length}
                </p>
                <div className="divide-y divide-border">
                  {configured.map(row)}
                </div>
              </>
            )}
            <div
              className={cn(
                "divide-y divide-border",
                configured.length > 0 && "border-t border-border",
              )}
            >
              {featured.map(row)}
            </div>
            <Collapsible open={showAll} onOpenChange={setShowAll}>
              <CollapsibleTrigger className="flex w-full items-center gap-2 border-t border-border px-3 py-2.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/40">
                <ChevronRight
                  className={cn(
                    "size-4 shrink-0 transition-transform",
                    showAll && "rotate-90",
                  )}
                />
                {showAll ? "Show fewer" : `Show all providers (${rest.length})`}
              </CollapsibleTrigger>
              <CollapsibleContent className="divide-y divide-border border-t border-border">
                {rest.map(row)}
              </CollapsibleContent>
            </Collapsible>
          </div>
        )}
      </div>

      <OAuthLoginDialog
        provider={loginProvider}
        onOpenChange={(open) => {
          if (!open) setLoginProvider(null);
        }}
        onConnected={refresh}
      />
    </div>
  );
}
