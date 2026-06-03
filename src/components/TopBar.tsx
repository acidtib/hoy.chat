import { Activity, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-background/60 px-4 backdrop-blur-sm">
      <div className="flex min-w-0 items-center gap-2">
        <ModelSelect
          models={models}
          current={
            currentModel
              ? { provider: currentModel.provider, id: currentModel.id }
              : null
          }
          disabled={selecting}
          onSelect={onSelectModel}
        />
      </div>

      <div className="flex items-center gap-1">
        {/* Developer round-trip; kept reachable but visually subordinate. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              onClick={onDebug}
              disabled={busy}
              aria-label="Debug get_state"
            >
              <Activity className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {busy ? "Calling get_state..." : "Debug: get_state"}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              onClick={onOpenSettings}
              aria-label="Settings"
            >
              <Settings className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Settings</TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}
