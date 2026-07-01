import { useMemo, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  MoreHorizontal,
  Search,
  Sparkle,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { SidebarShell } from "@/components/Sidebar";
import {
  bucketByRecency,
  cn,
  formatRelativeTime,
  RECENCY_ORDER,
  type RecencyBucket,
} from "@/lib/utils";
import { useSessionStore } from "@/state/store";
import type { Thread } from "@/lib/types";

type HistoryItem = { thread: Thread; projectName: string };

// Zed-style thread history: a flat, searchable list of every thread across
// projects, grouped by recency. Toggled from the bottom-bar clock. The archive
// toggle flips between active threads and the archived ones (where each can be
// restored or permanently deleted).
export function ThreadHistory() {
  const projects = useSessionStore((s) => s.projects);
  const activeThreadId = useSessionStore((s) => s.activeThreadId);
  const openThread = useSessionStore((s) => s.openThread);
  const requestTeardown = useSessionStore((s) => s.requestTeardown);
  const unarchiveThread = useSessionStore((s) => s.unarchiveThread);

  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const normalized = query.trim().toLowerCase();

  const groups = useMemo(() => {
    const items: HistoryItem[] = [];
    for (const p of projects) {
      for (const t of p.threads) items.push({ thread: t, projectName: p.name });
    }
    const filtered = items
      .filter((i) => !!i.thread.archived === showArchived)
      .filter(
        (i) =>
          !normalized ||
          i.thread.title.toLowerCase().includes(normalized) ||
          i.projectName.toLowerCase().includes(normalized),
      )
      .sort((a, b) => b.thread.updatedAt - a.thread.updatedAt);

    const byBucket = new Map<RecencyBucket, HistoryItem[]>();
    for (const i of filtered) {
      const bucket = bucketByRecency(i.thread.updatedAt);
      const list = byBucket.get(bucket);
      if (list) list.push(i);
      else byBucket.set(bucket, [i]);
    }
    return {
      count: filtered.length,
      sections: RECENCY_ORDER.filter((b) => byBucket.has(b)).map((b) => ({
        bucket: b,
        items: byBucket.get(b)!,
      })),
    };
  }, [projects, showArchived, normalized]);

  return (
    <SidebarShell>
      <div className="flex items-center gap-1 p-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search all threads..."
            className="h-8 w-full rounded-md border border-transparent bg-transparent pl-8 pr-2 text-sm text-sidebar-foreground placeholder:text-muted-foreground focus:border-border focus:bg-background/40 focus:outline-none"
          />
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className={cn(
                "size-7 hover:text-foreground",
                showArchived ? "text-brand" : "text-muted-foreground",
              )}
              onClick={() => setShowArchived((v) => !v)}
              aria-label="Toggle archived"
            >
              <Archive className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {showArchived ? "Show active threads" : "Show archived threads"}
          </TooltipContent>
        </Tooltip>
      </div>

      <div className="px-3 pb-1 text-[11px] uppercase tracking-wider text-muted-foreground/70">
        {groups.count} {showArchived ? "archived" : ""}{" "}
        {groups.count === 1 ? "thread" : "threads"}
      </div>

      <nav className="scrollbar-thin flex-1 overflow-y-auto px-1.5 pb-2">
        {groups.count === 0 ? (
          <p className="px-2.5 py-2 text-xs text-muted-foreground">
            {showArchived ? "No archived threads." : "No threads yet."}
          </p>
        ) : (
          groups.sections.map((section) => (
            <div key={section.bucket} className="mb-2">
              <div className="px-2.5 py-1 text-[11px] text-muted-foreground/70">
                {section.bucket}
              </div>
              <ul className="flex flex-col gap-0.5">
                {section.items.map(({ thread, projectName }) => (
                  <HistoryRow
                    key={thread.id}
                    thread={thread}
                    projectName={projectName}
                    active={thread.id === activeThreadId}
                    archived={showArchived}
                    onSelect={() => openThread(thread.id)}
                    onArchive={() => requestTeardown("archive", thread.id)}
                    onUnarchive={() => unarchiveThread(thread.id)}
                    onDelete={() => requestTeardown("delete", thread.id)}
                  />
                ))}
              </ul>
            </div>
          ))
        )}
      </nav>
    </SidebarShell>
  );
}

function HistoryRow({
  thread,
  projectName,
  active,
  archived,
  onSelect,
  onArchive,
  onUnarchive,
  onDelete,
}: {
  thread: Thread;
  projectName: string;
  active: boolean;
  archived: boolean;
  onSelect: () => void;
  onArchive: () => void;
  onUnarchive: () => void;
  onDelete: () => void;
}) {
  return (
    <li
      className={cn(
        "group flex items-center gap-2 rounded-md pl-3 pr-1 transition-colors",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "hover:bg-sidebar-accent/50",
      )}
    >
      <button
        onClick={onSelect}
        className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 py-1.5 text-left"
      >
        <Sparkle
          className={cn(
            "mt-0.5 size-3.5 shrink-0",
            active ? "text-brand" : "text-muted-foreground",
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm leading-tight">
            {thread.title}
          </span>
          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
            {projectName} &middot; {formatRelativeTime(thread.updatedAt)}
          </span>
        </span>
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-6 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
            aria-label="Thread options"
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-40">
          {archived ? (
            <>
              <DropdownMenuItem onSelect={onUnarchive}>
                <ArchiveRestore className="size-4" />
                Unarchive
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                <Trash2 className="size-4" />
                Delete permanently
              </DropdownMenuItem>
            </>
          ) : (
            <DropdownMenuItem onSelect={onArchive}>
              <Archive className="size-4" />
              Archive
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
