import { useMemo, useState } from "react";
import { ChevronRight, ChevronsUpDown, Search } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { modelKey, sameModel, setModelsEnabled, visibleModels } from "@/lib/models";
import type { ModelInfo, ModelRef } from "@/lib/types";
import { useSessionStore } from "@/state/store";
import { usePrefsStore } from "@/state/prefs";
import { PanelHeader, Section } from "./panels";
import { ProviderGlyph, glyphSlugFor } from "./providerIcons";
import { initialsFor } from "./providerMeta";

// Providers with more models than this start collapsed.
const COLLAPSE_OVER = 12;

type Filter = "all" | "on" | "off";


function groupByProvider(models: ModelInfo[]): [string, ModelInfo[]][] {
  const map = new Map<string, ModelInfo[]>();
  for (const m of models) {
    const arr = map.get(m.provider) ?? [];
    arr.push(m);
    map.set(m.provider, arr);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function formatContext(n?: number | null): string | null {
  if (!n) return null;
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

function Tag({ children, brand, title }: { children: string; brand?: boolean; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        "shrink-0 border px-1.5 py-px text-[10px] leading-4",
        brand
          ? "border-brand/40 bg-brand/10 text-brand"
          : "border-border text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

// The provider's glyph, or its initials when none is mapped.
function ProviderIcon({ provider, label, className }: { provider: string; label: string; className?: string }) {
  const slug = glyphSlugFor(provider);
  if (slug) return <ProviderGlyph slug={slug} className={cn("size-4 shrink-0", className)} />;
  return (
    <span aria-hidden className={cn("w-4 shrink-0 text-center text-[9px] font-semibold tracking-wide", className)}>
      {initialsFor(label)}
    </span>
  );
}

export function ModelsPanel() {
  const models = useSessionStore((s) => s.models);
  const piDefault = useSessionStore((s) => s.defaultModel);
  const providers = useSessionStore((s) => s.supportedProviders);
  const preferred = usePrefsStore((s) => s.preferredModel);
  const decisionModel = usePrefsStore((s) => s.decisionModel);
  const disabled = usePrefsStore((s) => s.disabledModels);
  const setPref = usePrefsStore((s) => s.setPref);

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [toggled, setToggled] = useState<Record<string, boolean>>({});

  const off = useMemo(() => new Set(disabled), [disabled]);
  const labelOf = (id: string) => providers.find((p) => p.id === id)?.label ?? id;
  const pickable = useMemo(
    () => groupByProvider(visibleModels(models, disabled, preferred)),
    [models, disabled, preferred],
  );
  const decisionPickable = useMemo(
    () => groupByProvider(visibleModels(models, disabled, decisionModel)),
    [models, disabled, decisionModel],
  );
  const groups = useMemo(() => groupByProvider(models), [models]);

  const q = query.trim().toLowerCase();
  const matches = (m: ModelInfo) => {
    const isOn = !off.has(modelKey(m));
    if (filter === "on" && !isOn) return false;
    if (filter === "off" && isOn) return false;
    return !q || `${m.name} ${m.id} ${m.provider}`.toLowerCase().includes(q);
  };

  const setEnabled = (keys: string[], enabled: boolean) => {
    // The default model stays on; turning it off would strand new threads.
    const keep = preferred ? keys.filter((k) => k !== modelKey(preferred)) : keys;
    setPref("disabledModels", setModelsEnabled(disabled, keep, enabled));
  };

  const lastUsed = piDefault
    ? (models.find((m) => sameModel(m, piDefault))?.name ?? piDefault.id)
    : null;

  return (
    <div className="space-y-8">
      <PanelHeader
        title="Model"
        description="Pick the model new threads start with and choose which models show up in the model picker."
      />

      <Section
        title="Default model"
        description="New threads and agents start on this model. You can still switch per thread from the composer."
      >
        <div className="mt-4">
          {models.length === 0 ? (
            <p className="border border-border bg-muted/20 px-3 py-2.5 text-sm text-muted-foreground">
              Connect a provider in the Providers section to choose a model.
            </p>
          ) : (
            <DefaultModelPicker
              models={pickable}
              labelOf={labelOf}
              current={preferred ?? piDefault}
              currentInfo={models.find((m) => sameModel(m, preferred ?? piDefault))}
              checked={preferred}
              noneLabel="Last used"
              activeSuffix={!preferred ? `(${lastUsed ?? "last used"})` : undefined}
              onPick={(ref) => {
                setPref("preferredModel", ref);
                if (ref) setPref("disabledModels", setModelsEnabled(disabled, [modelKey(ref)], true));
              }}
            />
          )}
        </div>
      </Section>

      <Section
        title="Decision model"
        description="The model the Fleet Dispatcher uses to route tasks in Auto mode. By default it uses the cheapest enabled model across your providers."
      >
        <div className="mt-4">
          {models.length === 0 ? (
            <p className="border border-border bg-muted/20 px-3 py-2.5 text-sm text-muted-foreground">
              Connect a provider in the Providers section to choose a model.
            </p>
          ) : (
            <DefaultModelPicker
              models={decisionPickable}
              labelOf={labelOf}
              current={decisionModel}
              currentInfo={models.find((m) => sameModel(m, decisionModel))}
              checked={decisionModel}
              noneLabel="Cheapest available"
              onPick={(ref) => setPref("decisionModel", ref)}
            />
          )}
        </div>
      </Section>

      {models.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold">Available models</h2>
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter models"
                className="h-8 pl-8 text-sm"
              />
            </div>
            <div className="flex shrink-0 border border-border" role="group" aria-label="Show">
              {(["all", "on", "off"] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFilter(f)}
                  aria-pressed={filter === f}
                  className={cn(
                    "h-8 cursor-pointer px-3 text-xs capitalize transition-colors",
                    filter === f
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-3">
            {groups.map(([provider, list]) => {
              const shown = list.filter(matches);
              if (shown.length === 0) return null;
              const on = list.filter((m) => !off.has(modelKey(m))).length;
              const expanded =
                q !== "" || (toggled[provider] ?? list.length <= COLLAPSE_OVER);
              return (
                <ProviderGroup
                  key={provider}
                  label={labelOf(provider)}
                  provider={provider}
                  on={on}
                  total={list.length}
                  expanded={expanded}
                  onExpand={() => setToggled((t) => ({ ...t, [provider]: !expanded }))}
                  onToggleAll={(v) => setEnabled(list.map(modelKey), v)}
                >
                  {shown.map((m) => (
                    <ModelRow
                      key={modelKey(m)}
                      model={m}
                      on={!off.has(modelKey(m))}
                      isDefault={sameModel(m, preferred)}
                      onToggle={(v) => setEnabled([modelKey(m)], v)}
                    />
                  ))}
                </ProviderGroup>
              );
            })}
          </div>
        </div>
      )}

    </div>
  );
}

function DefaultModelPicker({
  models,
  labelOf,
  current,
  currentInfo,
  checked,
  noneLabel,
  activeSuffix,
  onPick,
}: {
  models: [string, ModelInfo[]][];
  labelOf: (provider: string) => string;
  current: ModelRef | null;
  currentInfo?: ModelInfo;
  checked: ModelRef | null;
  noneLabel: string;
  activeSuffix?: string;
  onPick: (ref: ModelRef | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const pick = (ref: ModelRef | null) => {
    onPick(ref);
    setOpen(false);
  };
  return (
    // Modal so its own scroll lock lets the wheel reach the list inside the settings dialog.
    <Popover modal open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex w-full cursor-pointer items-center justify-between gap-3 border border-input bg-input/30 px-3 py-2 transition-colors hover:bg-input/50"
        >
          <DefaultModelValue
            model={current}
            info={currentInfo}
            providerLabel={labelOf(current?.provider ?? "")}
            noneLabel={noneLabel}
            activeSuffix={activeSuffix}
          />
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--radix-popover-trigger-width) rounded-none p-0">
        <Command>
          <CommandInput placeholder="Search models" />
          <CommandList className="scrollbar-thin max-h-[50vh]">
            <CommandEmpty>No models found.</CommandEmpty>
            <CommandGroup>
              <CommandItem value="none" data-checked={!checked} onSelect={() => pick(null)}>
                {noneLabel}
              </CommandItem>
            </CommandGroup>
            {models.map(([provider, list]) => (
              <CommandGroup key={provider} heading={labelOf(provider)}>
                {list.map((m) => (
                  <CommandItem
                    key={modelKey(m)}
                    value={`${m.name || m.id} ${m.id} ${labelOf(provider)}`}
                    data-checked={sameModel(m, checked)}
                    onSelect={() => pick({ provider: m.provider, id: m.id })}
                  >
                    <ProviderIcon provider={m.provider} label={labelOf(m.provider)} />
                    <span className="truncate">{m.name || m.id}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function DefaultModelValue({
  model,
  info,
  providerLabel,
  noneLabel,
  activeSuffix,
}: {
  model: ModelRef | null;
  info?: ModelInfo;
  providerLabel: string;
  noneLabel: string;
  activeSuffix?: string;
}) {
  if (!model) return <span className="text-muted-foreground">{noneLabel}</span>;
  const name = info?.name || model.id;
  return (
    <span className="flex min-w-0 items-center gap-3 text-left">
      <span className="flex size-8 shrink-0 items-center justify-center border border-border bg-muted/30">
        <ProviderIcon provider={model.provider} label={providerLabel} />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm text-foreground">
          {name}
          {activeSuffix && <span className="text-muted-foreground"> {activeSuffix}</span>}
        </span>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{providerLabel}</span>
          {name !== model.id && <span className="truncate font-mono">{model.id}</span>}
        </span>
      </span>
    </span>
  );
}

function ProviderGroup({
  label,
  provider,
  on,
  total,
  expanded,
  onExpand,
  onToggleAll,
  children,
}: {
  label: string;
  provider: string;
  on: number;
  total: number;
  expanded: boolean;
  onExpand: () => void;
  onToggleAll: (enabled: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <section className="border border-border bg-card/40">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <button
          type="button"
          onClick={onExpand}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-left"
        >
          <ChevronRight
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
              expanded && "rotate-90",
            )}
          />
          <ProviderIcon provider={provider} label={label} />
          <span className="truncate text-sm font-medium">{label}</span>
          <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
            {on} of {total} on
          </span>
        </button>
        <Switch
          checked={on > 0}
          onCheckedChange={onToggleAll}
          aria-label={`Turn all ${label} models ${on > 0 ? "off" : "on"}`}
        />
      </div>
      {expanded && <ul className="divide-y divide-border border-t border-border">{children}</ul>}
    </section>
  );
}

function ModelRow({
  model,
  on,
  isDefault,
  onToggle,
}: {
  model: ModelInfo;
  on: boolean;
  isDefault: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const ctx = formatContext(model.contextWindow);
  const name = model.name || model.id;
  return (
    <li className="flex items-center gap-3 py-2 pr-3 pl-10">
      <div className={cn("flex min-w-0 flex-1 items-baseline gap-2", !on && "opacity-50")}>
        <span className="truncate text-sm">{name}</span>
        {name !== model.id && (
          <span className="truncate font-mono text-xs text-muted-foreground">{model.id}</span>
        )}
      </div>
      <div className={cn("flex shrink-0 items-center gap-1.5", !on && "opacity-50")}>
        {isDefault && <Tag brand>Default</Tag>}
        {model.reasoning && <Tag>reasoning</Tag>}
        {(model.input ?? ["text"]).map((kind) => (
          <Tag key={kind} title={`Accepts ${kind} input`}>
            {kind}
          </Tag>
        ))}
        {ctx && (
          <span className="w-10 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
            {ctx}
          </span>
        )}
      </div>
      <Switch
        checked={on || isDefault}
        disabled={isDefault}
        onCheckedChange={onToggle}
        aria-label={`Show ${name} in the model picker`}
      />
    </li>
  );
}
