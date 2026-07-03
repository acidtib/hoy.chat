import { useMemo } from "react";
import { Maximize2, Sparkle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { SidebarShell } from "@/components/Sidebar";
import { FleetTree } from "@/components/fleet/FleetTree";
import { useSessionStore } from "@/state/store";
import { fleetMembers, fleetRoots, fleetStatusCounts } from "@/state/fleet";

// Option B (design doc): the always-on, compact fleet surface toggled from
// ContextBar's footer, sitting in the sidebar slot beside Sidebar/ThreadHistory.
export function FleetRail() {
  const projects = useSessionStore((s) => s.projects);
  const streaming = useSessionStore((s) => s.streaming);
  const agentQueue = useSessionStore((s) => s.agentQueue);
  const threadErrors = useSessionStore((s) => s.threadErrors);
  const setBodyView = useSessionStore((s) => s.setBodyView);

  const roots = useMemo(() => fleetRoots(projects), [projects]);

  const { live, total } = useMemo(() => {
    let live = 0;
    let total = 0;
    for (const root of roots) {
      const memberIds = fleetMembers(projects, root.id).map((t) => t.id);
      const counts = fleetStatusCounts(memberIds, streaming, agentQueue, threadErrors);
      live += counts.running;
      total += memberIds.length;
    }
    return { live, total };
  }, [roots, projects, streaming, agentQueue, threadErrors]);

  return (
    <SidebarShell>
      <div className="flex items-center gap-1.5 p-2">
        <Sparkle className="size-3.5 text-agent" />
        <span className="text-sm font-medium text-sidebar-foreground">Fleet</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="ml-auto size-6 text-muted-foreground hover:text-foreground"
              onClick={() => setBodyView("fleet")}
              aria-label="Expand fleet view"
            >
              <Maximize2 className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Expand fleet view</TooltipContent>
        </Tooltip>
      </div>

      {roots.length > 0 && (
        <div className="px-3 pb-1 text-[11px] uppercase tracking-wider text-muted-foreground">
          {live} running &middot; {total} total
        </div>
      )}

      {roots.length === 0 ? (
        <FleetEmptyState />
      ) : (
        <nav className="scrollbar-thin flex-1 overflow-y-auto px-1.5 pb-2">
          <div className="flex flex-col gap-3">
            {roots.map((root) => (
              <div key={root.id}>
                <p className="px-1.5 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {root.title}
                </p>
                <FleetTree dense rootId={root.id} />
              </div>
            ))}
          </div>
        </nav>
      )}
    </SidebarShell>
  );
}

// No fleets running: nothing to expand into, so unlike SidebarEmptyState there
// is no action button here.
function FleetEmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
      <p className="text-xs leading-relaxed text-muted-foreground">
        No agents running
      </p>
    </div>
  );
}
