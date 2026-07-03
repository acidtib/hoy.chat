import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { ArrowLeft, Sparkle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { FleetTree } from "@/components/fleet/FleetTree";
import { useSessionStore } from "@/state/store";
import {
  fleetMembers,
  fleetRollup,
  fleetRoots,
  fleetStatusCounts,
  pickByIds,
} from "@/state/fleet";
import { formatTokens } from "@/lib/utils";

// Option A (design doc): the full-body fleet dashboard, reached from the
// footer's Fleet button. One card per fleet over the shared recursive tree.
export function FleetBoard() {
  const projects = useSessionStore((s) => s.projects);
  const setBodyView = useSessionStore((s) => s.setBodyView);

  const roots = useMemo(() => fleetRoots(projects), [projects]);

  // Union of every fleet's member ids for the whole-app rollup line; a Set
  // dedupes in case a member ever resolved under two roots.
  const allMemberIds = useMemo(() => {
    const ids = new Set<string>();
    for (const root of roots) {
      for (const t of fleetMembers(projects, root.id)) ids.add(t.id);
    }
    return [...ids];
  }, [roots, projects]);

  // Scoped to fleet members only (HOY-249): a delta from a thread outside every
  // fleet does not re-render the board.
  const streaming = useSessionStore(useShallow((s) => pickByIds(s.streaming, allMemberIds)));
  const stats = useSessionStore(useShallow((s) => pickByIds(s.stats, allMemberIds)));
  const threadErrors = useSessionStore(
    useShallow((s) => pickByIds(s.threadErrors, allMemberIds)),
  );
  const agentQueue = useSessionStore(
    useShallow((s) => s.agentQueue.filter((id) => allMemberIds.includes(id))),
  );

  const counts = useMemo(
    () => fleetStatusCounts(allMemberIds, streaming, agentQueue, threadErrors),
    [allMemberIds, streaming, agentQueue, threadErrors],
  );
  const rollup = useMemo(
    () => fleetRollup(allMemberIds, stats),
    [allMemberIds, stats],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => setBodyView("panels")}
              aria-label="Back to panels"
            >
              <ArrowLeft className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Back to panels</TooltipContent>
        </Tooltip>

        <Sparkle className="size-4 text-agent" />
        <h1 className="text-sm font-medium text-foreground">FleetView</h1>

        <div className="ml-auto flex items-center gap-3 font-mono text-[11px] tabular-nums text-muted-foreground">
          <span>{counts.running} running</span>
          <span>{counts.done} done</span>
          <span>{counts.queued} queued</span>
          {counts.error > 0 && (
            <span className="text-destructive">{counts.error} error</span>
          )}
          <span>{formatTokens(rollup.tokens)}</span>
          <span>${rollup.cost.toFixed(rollup.cost < 1 ? 4 : 2)}</span>
        </div>
      </div>

      {roots.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          <p className="text-xs leading-relaxed text-muted-foreground">
            No agents running
          </p>
        </div>
      ) : (
        <div className="scrollbar-thin flex-1 overflow-y-auto p-4">
          <div className="flex flex-col gap-3">
            {roots.map((root) => (
              <FleetCard key={root.id} rootId={root.id} title={root.title} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// One fleet's card: header (title, member count, that fleet's own rollup)
// over the shared recursive tree at the full (non-dense) row width.
function FleetCard({ rootId, title }: { rootId: string; title: string }) {
  const projects = useSessionStore((s) => s.projects);

  const members = useMemo(
    () => fleetMembers(projects, rootId),
    [projects, rootId],
  );
  const memberIds = useMemo(() => members.map((t) => t.id), [members]);
  // Scoped to this fleet's members (HOY-249).
  const stats = useSessionStore(useShallow((s) => pickByIds(s.stats, memberIds)));
  const rollup = useMemo(
    () => fleetRollup(memberIds, stats),
    [memberIds, stats],
  );

  return (
    <div className="border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {title}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {members.length} agent{members.length === 1 ? "" : "s"}
        </span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
          {formatTokens(rollup.tokens)} &middot; $
          {rollup.cost.toFixed(rollup.cost < 1 ? 4 : 2)}
        </span>
      </div>
      <div className="p-2">
        <FleetTree dense={false} rootId={rootId} />
      </div>
    </div>
  );
}
