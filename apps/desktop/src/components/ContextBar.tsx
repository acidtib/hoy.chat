import { useState } from "react";
import { Popover } from "radix-ui";
import { Clock, FolderPlus, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
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
  const expandedThreadId = useSessionStore((s) => s.expandedThreadId);

  // Mirror the panel strip: one full-width slice while a panel is full screen.
  const expandedPanel = panels.find((p) => p.id === expandedThreadId) ?? null;

  async function handleAddProject() {
    const dir = await pickDirectory();
    if (dir) addProject(dir);
  }

  return (
    <footer className="relative flex h-8 shrink-0 items-stretch border-t border-border bg-sidebar text-[11px] text-muted-foreground">
      {collapsed ? (
        // With the sidebar collapsed the panels start at the window edge, so the
        // open button floats over the slices (solid bg masks anything scrolled
        // beneath) instead of taking a cell that would push them out of line;
        // the first slice clears it with extra padding.
        <div className="absolute inset-y-0 left-0 z-10 flex items-center bg-sidebar pl-1.5">
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
        {expandedPanel ? (
          <PanelStats
            threadId={expandedPanel.id}
            fullWidth
            inset={collapsed}
          />
        ) : (
          panels.map((panel, i) => (
            <PanelStats
              key={panel.id}
              threadId={panel.id}
              width={panel.width}
              inset={collapsed && i === 0}
            />
          ))
        )}
      </div>
    </footer>
  );
}

// One panel's footer slice: the thread's context window and cost, sized to the
// panel above it. `inset` clears the floating open-sidebar button.
function PanelStats({
  threadId,
  width,
  inset = false,
  fullWidth = false,
}: {
  threadId: string;
  width?: number;
  inset?: boolean;
  fullWidth?: boolean;
}) {
  const stats = useSessionStore((s) => s.stats[threadId] ?? null);
  const statuses = useSessionStore((s) => s.statuses[threadId]);
  const statusEntries = statuses ? Object.entries(statuses) : [];

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
      style={fullWidth ? undefined : { width }}
      className={cn(
        "flex shrink-0 items-center gap-3 border-r border-border px-3 font-mono tabular-nums",
        fullWidth && "flex-1 border-r-0",
        inset && "pl-10",
      )}
    >
      <span>
        {ctxLabel} &middot; {pctLabel}
      </span>

      <Divider />

      <span>{costLabel}</span>

      <Divider />
      <CompactControl threadId={threadId} />

      {statusEntries.map(([key, text]) => (
        <span key={key} className="contents">
          <Divider />
          <span className="truncate text-foreground/80">{text}</span>
        </span>
      ))}
    </div>
  );
}

// Manual compaction affordance next to the usage meter (HOY-229): a small
// trigger opening a popover with an optional custom-instructions field. Gated on
// an idle, live session; shows "compacting..." while a compaction runs.
function CompactControl({ threadId }: { threadId: string }) {
  const compacting = useSessionStore((s) => s.compacting[threadId] ?? false);
  const streaming = useSessionStore((s) => s.streaming[threadId] ?? false);
  const runCompact = useSessionStore((s) => s.compact);
  const hasSession = useSessionStore((s) => {
    for (const p of s.projects) {
      const t = p.threads.find((th) => th.id === threadId);
      if (t) return Boolean(t.sessionId);
    }
    return false;
  });
  const [open, setOpen] = useState(false);
  const [instructions, setInstructions] = useState("");

  if (!hasSession) {
    return <span className="text-muted-foreground/50">compact</span>;
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={cn(
            "rounded transition-colors hover:text-foreground",
            compacting ? "text-brand" : "text-muted-foreground",
          )}
          aria-label="Compact context"
        >
          {compacting ? "compacting..." : "compact"}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="end"
          sideOffset={8}
          className="z-50 w-72 rounded-lg bg-popover p-3 font-sans text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none"
        >
          <p className="text-sm font-medium">Compact context</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Summarize the conversation to free up the context window.
          </p>
          <Textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="Optional: summarize with focus on..."
            className="mt-2 h-20 resize-none text-sm"
          />
          {streaming && (
            <p className="mt-2 text-xs text-muted-foreground">
              Finish the current turn before compacting.
            </p>
          )}
          <div className="mt-2 flex justify-end">
            <Button
              size="sm"
              disabled={streaming || compacting}
              onClick={() => {
                void runCompact(threadId, instructions.trim() || undefined);
                setInstructions("");
                setOpen(false);
              }}
            >
              {compacting ? "Compacting..." : "Compact now"}
            </Button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
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
