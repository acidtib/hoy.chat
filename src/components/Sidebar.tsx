import { MessageSquare, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
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
    <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-sidebar">
      <div className="flex h-14 items-center gap-2.5 px-4">
        <div className="flex size-7 items-center justify-center rounded-lg bg-brand font-semibold text-brand-foreground shadow-sm">
          <span className="text-base leading-none">&#960;</span>
        </div>
        <div className="flex flex-col">
          <span className="text-sm font-semibold leading-tight text-sidebar-foreground">
            Pi Desktop
          </span>
          <span className="text-[11px] leading-tight text-muted-foreground">
            Coding agent
          </span>
        </div>
      </div>

      <div className="px-3 pb-2">
        {/* New session lands in M4. */}
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-full justify-start gap-2 text-muted-foreground"
          disabled
        >
          <Plus className="size-4" />
          New session
        </Button>
      </div>

      <div className="flex items-center justify-between px-4 pb-1.5 pt-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Sessions
        </span>
        {sessions.length > 0 && (
          <span className="text-[11px] tabular-nums text-muted-foreground/70">
            {sessions.length}
          </span>
        )}
      </div>

      <nav className="scrollbar-thin flex-1 overflow-y-auto px-2 pb-2">
        {sessions.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            No sessions yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {sessions.map((session) => {
              const active = session.id === activeId;
              return (
                <li key={session.id}>
                  <button
                    className={cn(
                      "group relative flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors",
                      active
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : "text-sidebar-foreground hover:bg-sidebar-accent/60",
                    )}
                  >
                    {active && (
                      <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-brand" />
                    )}
                    <MessageSquare
                      className={cn(
                        "size-4 shrink-0",
                        active
                          ? "text-foreground"
                          : "text-muted-foreground group-hover:text-foreground",
                      )}
                    />
                    <span className="truncate font-medium">{session.title}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </nav>
    </aside>
  );
}
