import { Activity, ChevronDown, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ModelInfo } from "@/lib/types";

export function TopBar({
  model,
  onDebug,
  busy,
}: {
  model?: ModelInfo | null;
  onDebug: () => void;
  busy: boolean;
}) {
  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
      {/* Real model selector populates in M2. */}
      <Button variant="ghost" size="sm" className="gap-2" disabled>
        <span className="text-sm font-medium">{model?.name ?? model?.id ?? "Select model"}</span>
        <ChevronDown className="size-4 text-muted-foreground" />
      </Button>
      <div className="flex items-center gap-1">
        <Button variant="outline" size="sm" className="gap-2" onClick={onDebug} disabled={busy}>
          <Activity className="size-4" />
          {busy ? "Calling..." : "Debug: get_state"}
        </Button>
        {/* Settings modal lands in M2. */}
        <Button variant="ghost" size="icon" disabled>
          <Settings className="size-4" />
        </Button>
      </div>
    </header>
  );
}
