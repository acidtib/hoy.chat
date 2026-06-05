import { Clock, FolderPlus, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn, formatTokens } from "@/lib/utils";
import { pickDirectory } from "@/lib/ipc";
import { useSessionStore } from "@/state/store";
import type { PiState } from "@/lib/types";

// Single full-width status bar (Zed-style): the sidebar controls live in the
// left segment, aligned to the sidebar's width and divided by its border, while
// the right segment shows the focused thread's live model/status/usage. Context
// window and cost come from get_session_stats, refreshed after each turn.
export function ContextBar({ state }: { state: PiState | null }) {
  const collapsed = useSessionStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useSessionStore((s) => s.toggleSidebar);
  const addProject = useSessionStore((s) => s.addProject);
  const sidebarWidth = useSessionStore((s) => s.sidebarWidth);
  const sidebarView = useSessionStore((s) => s.sidebarView);
  const setSidebarView = useSessionStore((s) => s.setSidebarView);
  const activeThreadId = useSessionStore((s) => s.activeThreadId);
  const stats = useSessionStore((s) =>
    activeThreadId ? (s.stats[activeThreadId] ?? null) : null,
  );
  const threadStreaming = useSessionStore((s) =>
    activeThreadId ? (s.streaming[activeThreadId] ?? false) : false,
  );

  const model = state?.model?.id ?? "no model";
  // Per-thread streaming: the control session backing `state` never runs a turn,
  // so its isStreaming is always false. The focused thread's flag is the truth.
  const streaming = threadStreaming;
  const status = streaming ? "streaming" : "idle";

  const usage = stats?.contextUsage;
  const ctxLabel =
    usage && usage.tokens != null
      ? `ctx ${formatTokens(usage.tokens)}/${formatTokens(usage.contextWindow)}`
      : "ctx --/--";
  const pctLabel =
    usage && usage.percent != null ? `${Math.round(usage.percent)}%` : "--%";
  const costLabel =
    stats != null ? `$${stats.cost.toFixed(stats.cost < 1 ? 4 : 2)}` : "$--";

  async function handleAddProject() {
    const dir = await pickDirectory();
    if (dir) addProject(dir);
  }

  return (
    <footer className="flex h-8 shrink-0 items-stretch border-t border-border bg-sidebar text-[11px] text-muted-foreground">
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
        <div
          style={{ width: sidebarWidth }}
          className="flex shrink-0 items-center gap-0.5 border-r border-border px-1.5"
        >
          <FooterIconButton label="Toggle Sidebar" onClick={toggleSidebar}>
            <PanelLeftClose className="size-4" />
          </FooterIconButton>
          <FooterIconButton
            label={sidebarView === "history" ? "Show Projects" : "Show Thread History"}
            onClick={() =>
              setSidebarView(sidebarView === "history" ? "projects" : "history")
            }
            active={sidebarView === "history"}
          >
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

        <span className="font-mono tabular-nums">
          {ctxLabel} &middot; {pctLabel}
        </span>

        <Divider />

        <span className="font-mono tabular-nums">{costLabel}</span>

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
  active = false,
}: {
  label: string;
  children: React.ReactNode;
  onClick?: () => void;
  className?: string;
  tooltipSide?: "top" | "right";
  active?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn(
            "size-7 hover:text-foreground",
            active ? "text-brand" : "text-muted-foreground",
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
