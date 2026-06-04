import { useMemo, useState } from "react";
import { Check } from "lucide-react";
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector";
import { cn } from "@/lib/utils";
import type { ModelInfo } from "@/lib/types";

function groupByProvider(models: ModelInfo[]): Array<[string, ModelInfo[]]> {
  const groups = new Map<string, ModelInfo[]>();
  for (const m of models) {
    const list = groups.get(m.provider);
    if (list) list.push(m);
    else groups.set(m.provider, [m]);
  }
  return [...groups.entries()];
}

// Compact context-window label for the right column: 200000 -> 200K, 1000000 -> 1M.
function formatContext(n?: number | null): string | null {
  if (!n) return null;
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

export function ModelSelect({
  models,
  current,
  disabled,
  onSelect,
}: {
  models: ModelInfo[];
  current?: { provider: string; id: string } | null;
  disabled?: boolean;
  onSelect: (provider: string, modelId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const groups = useMemo(() => groupByProvider(models), [models]);
  const currentModel = useMemo(
    () =>
      current
        ? models.find(
            (m) => m.provider === current.provider && m.id === current.id,
          )
        : null,
    [models, current],
  );

  const empty = models.length === 0;
  const triggerLabel = currentModel?.name || currentModel?.id;

  return (
    <ModelSelector open={open} onOpenChange={setOpen}>
      <ModelSelectorTrigger asChild>
        <button
          type="button"
          disabled={disabled || empty}
          className="max-w-[320px] cursor-pointer truncate text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
        >
          {triggerLabel ?? (empty ? "No models" : "Select model")}
        </button>
      </ModelSelectorTrigger>
      <ModelSelectorContent
        title="Select a model"
        className="overflow-hidden sm:max-w-lg"
      >
        <ModelSelectorInput placeholder="Search models..." />
        <ModelSelectorList className="scrollbar-thin">
          <ModelSelectorEmpty>No models found.</ModelSelectorEmpty>
          {groups.map(([provider, items]) => (
            <ModelSelectorGroup
              key={provider}
              heading={provider}
              className="[&_[cmdk-group-heading]]:capitalize"
            >
              {items.map((m) => {
                const ctx = formatContext(m.contextWindow);
                const selected =
                  !!current &&
                  current.provider === m.provider &&
                  current.id === m.id;
                return (
                  <ModelSelectorItem
                    key={`${m.provider} ${m.id}`}
                    value={`${m.name || m.id} ${m.provider} ${m.id}`}
                    onSelect={() => {
                      onSelect(m.provider, m.id);
                      setOpen(false);
                    }}
                    className="gap-2"
                  >
                    <span className="flex-1 truncate">{m.name || m.id}</span>
                    {ctx && (
                      <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                        {ctx}
                      </span>
                    )}
                    <Check
                      className={cn(
                        "size-4 shrink-0 text-brand",
                        selected ? "opacity-100" : "opacity-0",
                      )}
                    />
                  </ModelSelectorItem>
                );
              })}
            </ModelSelectorGroup>
          ))}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  );
}
