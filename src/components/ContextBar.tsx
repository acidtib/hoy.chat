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

// Single full-width status bar (Zed-style): the sidebar controls live in the
// left segment, aligned to the sidebar's width and divided by its border. The
// rest mirrors the panel strip: each open panel owns a slice (same width,
// horizontal scroll synced by App via `slicesRef`) showing its own thread's
// context window and cost from get_session_stats, refreshed after each turn.
// The model is per thread and lives in each composer's selector, not here.
export function ContextBar({
  slicesRef,
}: {
  slicesRef?: React.Ref<HTMLDivElement>;
}) {
  const collapsed = useSessionStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useSessionStore((s) => s.toggleSidebar);
  const addProject = useSessionStore((s) => s.addProject);
  const sidebarWidth = useSessionStore((s) => s.sidebarWidth);
  const sidebarView = useSessionStore((s) => s.sidebarView);
  const setSidebarView = useSessionStore((s) => s.setSidebarView);
  const panels = useSessionStore((s) => s.panels);

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

      {/* overflow-x-hidden: no scrollbar of its own; App mirrors the panel
          strip's scrollLeft here so each slice stays under its panel. */}
      <div ref={slicesRef} className="flex flex-1 items-stretch overflow-x-hidden">
        {panels.map((panel) => (
          <PanelStats key={panel.id} threadId={panel.id} width={panel.width} />
        ))}
      </div>
    </footer>
  );
}

// One panel's footer slice: the thread's context window and cost, sized to the
// panel above it.
function PanelStats({ threadId, width }: { threadId: string; width: number }) {
  const stats = useSessionStore((s) => s.stats[threadId] ?? null);

  const usage = stats?.contextUsage;
  const ctxLabel =
    usage && usage.tokens != null
      ? `ctx ${formatTokens(usage.tokens)}/${formatTokens(usage.contextWindow)}`
      : "ctx --/--";
  const pctLabel =
    usage && usage.percent != null ? `${Math.round(usage.percent)}%` : "--%";
  const costLabel =
    stats != null ? `$${stats.cost.toFixed(stats.cost < 1 ? 4 : 2)}` : "$--";

  return (
    <div
      style={{ width }}
      className="flex shrink-0 items-center gap-3 border-r border-border px-3 font-mono tabular-nums"
    >
      <span>
        {ctxLabel} &middot; {pctLabel}
      </span>

      <Divider />

      <span>{costLabel}</span>
    </div>
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
