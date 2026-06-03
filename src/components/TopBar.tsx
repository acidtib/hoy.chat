import { Activity, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ModelSelect } from "@/components/ModelSelect";
import type { ModelInfo } from "@/lib/types";

export function TopBar({
  models,
  currentModel,
  selecting,
  onSelectModel,
  onOpenSettings,
  onDebug,
  busy,
}: {
  models: ModelInfo[];
  currentModel?: ModelInfo | null;
  selecting: boolean;
  onSelectModel: (provider: string, modelId: string) => void;
  onOpenSettings: () => void;
  onDebug: () => void;
  busy: boolean;
}) {
  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
      <ModelSelect
        models={models}
        current={currentModel ? { provider: currentModel.provider, id: currentModel.id } : null}
        disabled={selecting}
        onSelect={onSelectModel}
      />
      <div className="flex items-center gap-1">
        <Button variant="outline" size="sm" className="gap-2" onClick={onDebug} disabled={busy}>
          <Activity className="size-4" />
          {busy ? "Calling..." : "Debug: get_state"}
        </Button>
        <Button variant="ghost" size="icon" onClick={onOpenSettings} aria-label="Settings">
          <Settings className="size-4" />
        </Button>
      </div>
    </header>
  );
}
