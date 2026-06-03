import { MessageSquare, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import type { SessionMeta } from "@/lib/types";

export function Sidebar({
  sessions,
  activeId,
}: {
  sessions: SessionMeta[];
  activeId: string | null;
}) {
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-sidebar">
      <div className="flex h-12 items-center px-3 text-sm font-medium text-sidebar-foreground">
        Sessions
      </div>
      <Separator />
      <div className="flex-1 overflow-y-auto p-2">
        {sessions.length === 0 ? (
          <p className="px-2 py-1 text-xs text-muted-foreground">No sessions yet</p>
        ) : (
          sessions.map((session) => (
            <button
              key={session.id}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                session.id === activeId
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground hover:bg-sidebar-accent/50",
              )}
            >
              <MessageSquare className="size-4 shrink-0" />
              <span className="truncate">{session.title}</span>
            </button>
          ))
        )}
      </div>
      <div className="p-2">
        {/* New session lands in M4. */}
        <Button variant="outline" size="sm" className="w-full justify-start gap-2" disabled>
          <Plus className="size-4" />
          New session
        </Button>
      </div>
    </aside>
  );
}
