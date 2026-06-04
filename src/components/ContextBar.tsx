import { Clock, FolderPlus, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { pickDirectory } from "@/lib/ipc";
import { useSessionStore } from "@/state/store";
import type { PiState } from "@/lib/types";

// Single full-width status bar (Zed-style): the sidebar controls live in the
// left segment, aligned to the sidebar's width and divided by its border, while
// the right segment shows live model/status. Real context-window usage and cost
// arrive in M3 via get_session_stats; for now those are placeholders.
export function ContextBar({ state }: { state: PiState | null }) {
  const collapsed = useSessionStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useSessionStore((s) => s.toggleSidebar);
  const addProject = useSessionStore((s) => s.addProject);

  const model = state?.model?.id ?? "no model";
  const streaming = state?.isStreaming ?? false;
  const status = streaming ? "streaming" : "idle";

  async function handleAddProject() {
    const dir = await pickDirectory();
    if (dir) addProject(dir);
  }

  return (
    <footer className="flex h-9 shrink-0 items-stretch border-t border-border bg-sidebar text-[11px] text-muted-foreground">
      {collapsed ? (
        <div className="flex items-center pl-1.5">
          <FooterIconButton
            label="Open Threads Sidebar"
            tooltipSide="right"
            onClick={toggleSidebar}
          >
            <PanelLeftOpen className="size-4" />
          </FooterIconButton>
        </div>
      ) : (
        <div className="flex w-64 shrink-0 items-center gap-0.5 border-r border-border px-1.5">
          <FooterIconButton label="Toggle Sidebar" onClick={toggleSidebar}>
            <PanelLeftClose className="size-4" />
          </FooterIconButton>
          <FooterIconButton label="Show Thread History">
            <Clock className="size-4" />
          </FooterIconButton>
          <FooterIconButton
            label="Add Project"
            className="ml-auto"
            onClick={handleAddProject}
          >
            <FolderPlus className="size-4" />
          </FooterIconButton>
        </div>
      )}

      <div className="flex flex-1 items-center gap-3 px-3">
        <span className="flex items-center gap-1.5">
          <span
            className={cn(
              "size-1.5 rounded-full",
              streaming ? "animate-pulse bg-brand" : "bg-muted-foreground/50",
            )}
            aria-hidden
          />
          <span className="capitalize">{status}</span>
        </span>

        <Divider />

        <span className="font-mono tabular-nums">ctx --/-- &middot; --%</span>

        <Divider />

        <span className="font-mono tabular-nums">$--</span>

        <span className="ml-auto truncate font-mono text-muted-foreground/80">
          {model}
        </span>
      </div>
    </footer>
  );
}

function FooterIconButton({
  label,
  children,
  onClick,
  className,
  tooltipSide = "top",
}: {
  label: string;
  children: React.ReactNode;
  onClick?: () => void;
  className?: string;
  tooltipSide?: "top" | "right";
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn(
            "size-7 text-muted-foreground hover:text-foreground",
            className,
          )}
          onClick={onClick}
          aria-label={label}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side={tooltipSide}>{label}</TooltipContent>
    </Tooltip>
  );
}

function Divider() {
  return <span className="h-3 w-px bg-border" aria-hidden />;
}
