import { useCallback, useMemo, useRef, useState } from "react";
import {
  Archive,
  ChevronDown,
  MoreHorizontal,
  Pencil,
  Plus,
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { InlineRename } from "@/components/InlineRename";
import { cn, formatRelativeTime } from "@/lib/utils";
import { useGlobalDrag } from "@/lib/useGlobalDrag";
import { pickDirectory } from "@/lib/ipc";
import { useSessionStore } from "@/state/store";
import { usePrefsStore } from "@/state/prefs";
import type { Project, Thread } from "@/lib/types";

// Cap on how many top-level threads a project group shows before collapsing the
// rest behind an "N more" row that opens the full Thread History (HOY-257).
const SIDEBAR_THREAD_CAP = 6;

export function Sidebar() {
  const projects = useSessionStore((s) => s.projects);
  const activeThreadId = useSessionStore((s) => s.activeThreadId);
  const panels = useSessionStore((s) => s.panels);
  const openThread = useSessionStore((s) => s.openThread);
  const addProject = useSessionStore((s) => s.addProject);
  const addThread = useSessionStore((s) => s.addThread);
  const removeProject = useSessionStore((s) => s.removeProject);

  const openIds = useMemo(() => new Set(panels.map((p) => p.id)), [panels]);

  async function handleOpenProject() {
    const dir = await pickDirectory(
      usePrefsStore.getState().defaultProjectDir || undefined,
    );
    if (dir) addProject(dir);
  }

  const [query, setQuery] = useState("");
  const normalized = query.trim().toLowerCase();

  const filtered = useMemo(() => {
    // Archived threads live in the history view, not the projects tree.
    const active = projects.map((p) => ({
      ...p,
      threads: p.threads.filter((t) => !t.archived),
    }));
    if (!normalized) return active;
    const matches = (t: Thread) => t.title.toLowerCase().includes(normalized);
    return active
      .map((p) => {
        const nameMatch = p.name.toLowerCase().includes(normalized);
        // Subagents no longer render as rows (HOY-250), so a search matches
        // top-level threads by title. Their children ride along in the array
        // (never shown) so the parent's fleet marker still computes.
        const matchedTop = new Set(
          p.threads.filter((t) => !t.parentThreadId && matches(t)).map((t) => t.id),
        );
        const threads = nameMatch
          ? p.threads
          : p.threads.filter(
              (t) =>
                matchedTop.has(t.id) ||
                (t.parentThreadId != null && matchedTop.has(t.parentThreadId)),
            );
        return { project: p, threads, keep: nameMatch || matchedTop.size > 0 };
      })
      .filter((x) => x.keep)
      .map((x) => ({ ...x.project, threads: x.threads }));
  }, [projects, normalized]);

  return (
    <SidebarShell>
      {projects.length === 0 ? (
        <SidebarEmptyState onOpenProject={handleOpenProject} />
      ) : (
        <>
          <div className="p-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search threads..."
                className="h-8 w-full rounded-md border border-transparent bg-transparent pl-8 pr-2 text-sm text-sidebar-foreground placeholder:text-muted-foreground focus:border-border focus:bg-background/40 focus:outline-none"
              />
            </div>
          </div>

          <nav className="scrollbar-thin flex-1 overflow-y-auto px-1.5 pb-2">
            {filtered.length === 0 ? (
              <p className="px-2.5 py-2 text-xs text-muted-foreground">
                No matching threads.
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {filtered.map((project) => (
                  <ProjectGroup
                    key={project.id}
                    project={project}
                    activeThreadId={activeThreadId}
                    openIds={openIds}
                    searching={normalized.length > 0}
                    threadCount={
                      projects.find((p) => p.id === project.id)?.threads.length ??
                      project.threads.length
                    }
                    onSelectThread={openThread}
                    onNewThread={() => addThread(project.id)}
                    onRemove={() => removeProject(project.id)}
                  />
                ))}
              </ul>
            )}
          </nav>
        </>
      )}
    </SidebarShell>
  );
}

// Shared sidebar chrome: fixed-width column with a draggable right edge. Wraps
// both the projects tree (Sidebar) and the history view (ThreadHistory) so they
// share width and the resize handle.
export function SidebarShell({ children }: { children: React.ReactNode }) {
  const sidebarWidth = useSessionStore((s) => s.sidebarWidth);
  return (
    <aside
      style={{ width: sidebarWidth }}
      className="relative flex shrink-0 flex-col border-r border-border bg-sidebar"
    >
      {children}
      <ResizeHandle />
    </aside>
  );
}

// Shown when no projects are open: the sidebar has nothing to list, so offer the
// way in. Add Project is the only real action today (cloning a repo has no
// backend yet).
function SidebarEmptyState({ onOpenProject }: { onOpenProject: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
      <p className="text-xs leading-relaxed text-muted-foreground">
        Add a project to start using threads
      </p>
      <button
        onClick={onOpenProject}
        className="mt-3 cursor-pointer text-sm font-medium text-foreground transition-colors hover:text-brand"
      >
        Add Project
      </button>
    </div>
  );
}

// Drag the sidebar's right edge to resize; the store clamps to min/max. The drag
// lifecycle (window listeners + body cursor, torn down on pointerup/cancel and on
// unmount) lives in the shared useGlobalDrag hook.
function ResizeHandle() {
  const setSidebarWidth = useSessionStore((s) => s.setSidebarWidth);
  const dragStart = useRef({ x: 0, width: 0 });
  const onMove = useCallback(
    (ev: PointerEvent) => {
      setSidebarWidth(
        dragStart.current.width + (ev.clientX - dragStart.current.x),
      );
    },
    [setSidebarWidth],
  );
  const { dragging, startDrag } = useGlobalDrag(onMove);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    dragStart.current = {
      x: e.clientX,
      width: useSessionStore.getState().sidebarWidth,
    };
    startDrag();
  }

  return (
    <div
      onPointerDown={onPointerDown}
      role="separator"
      aria-orientation="vertical"
      className="group/resize absolute -right-1 top-0 z-10 flex h-full w-2 cursor-col-resize justify-center"
    >
      <span
        className={cn(
          "h-full w-px transition-colors",
          dragging ? "bg-ring" : "bg-transparent group-hover/resize:bg-ring/60",
        )}
      />
    </div>
  );
}

function ProjectGroup({
  project,
  activeThreadId,
  openIds,
  searching,
  threadCount,
  onSelectThread,
  onNewThread,
  onRemove,
}: {
  project: Project;
  activeThreadId: string | null;
  openIds: Set<string>;
  searching: boolean;
  threadCount: number;
  onSelectThread: (id: string) => void;
  onNewThread: () => void;
  onRemove: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const expanded = searching || !collapsed;
  // Removing a project is destructive (drops the project and all its threads
  // from the workspace); gate it behind a confirm (HOY-225).
  const [confirmOpen, setConfirmOpen] = useState(false);
  const openThreadHistory = useSessionStore((s) => s.openThreadHistory);

  // Top-level threads, most-recent first. Children stay in project.threads for
  // the fleet-marker computation below; they never render as rows (HOY-250).
  const topThreads = useMemo(
    () =>
      project.threads
        .filter((t) => !t.parentThreadId)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [project.threads],
  );
  // Show the 6 most recent, but never hide the thread the user is looking at
  // (active or open). While searching the list is already the match set, so
  // show all matches rather than re-capping them (HOY-257).
  const shownThreads = searching
    ? topThreads
    : topThreads.filter(
        (t, i) =>
          i < SIDEBAR_THREAD_CAP ||
          t.id === activeThreadId ||
          openIds.has(t.id),
      );
  const hiddenCount = topThreads.length - shownThreads.length;

  return (
    <li>
      <div className="group/project flex h-7 items-center gap-1 rounded-md px-1.5 text-sidebar-foreground">
        <button
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 text-left"
          onClick={() => setCollapsed((c) => !c)}
        >
          <ChevronDown
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              expanded ? "" : "-rotate-90",
            )}
          />
          <span className="truncate text-sm font-medium">{project.name}</span>
        </button>

        <div className="flex items-center opacity-0 transition-opacity group-hover/project:opacity-100 focus-within:opacity-100">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-6 text-muted-foreground hover:text-foreground"
                onClick={onNewThread}
                aria-label="Start new thread"
              >
                <Plus className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Start new agent thread</TooltipContent>
          </Tooltip>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-6 text-muted-foreground hover:text-foreground"
                aria-label="Project options"
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                variant="destructive"
                onSelect={(e) => {
                  // Keep the menu's select from firing the removal directly;
                  // open the confirm dialog instead.
                  e.preventDefault();
                  setConfirmOpen(true);
                }}
              >
                <Trash2 />
                Remove project
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Remove {project.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  This removes the project and its {threadCount}{" "}
                  {threadCount === 1 ? "thread" : "threads"} from Hoy. It does not
                  delete the agent's session files on disk. This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={onRemove}>
                  Remove project
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {expanded && (
        <div className="mt-0.5 flex flex-col gap-0.5 pb-1">
          {topThreads.length === 0 ? (
            <p className="px-2.5 py-1 pl-7 text-xs text-muted-foreground">
              No threads yet
            </p>
          ) : (
            <>
              {shownThreads.map((thread) => (
                <ThreadRow
                  key={thread.id}
                  thread={thread}
                  active={thread.id === activeThreadId}
                  open={openIds.has(thread.id)}
                  onSelect={() => onSelectThread(thread.id)}
                  // Spawned subagents are watched in FleetView, not nested here
                  // (HOY-250); a teal marker just flags that this thread has a
                  // fleet.
                  isAgent={project.threads.some(
                    (c) => c.parentThreadId === thread.id,
                  )}
                />
              ))}
              {hiddenCount > 0 && (
                <button
                  onClick={() => openThreadHistory(project.id)}
                  className="cursor-pointer rounded-md py-1 pl-7 pr-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  {hiddenCount} more…
                </button>
              )}
            </>
          )}
        </div>
      )}
    </li>
  );
}

function ThreadRow({
  thread,
  active,
  open,
  onSelect,
  isAgent = false,
}: {
  thread: Thread;
  active: boolean;
  open: boolean;
  onSelect: () => void;
  isAgent?: boolean;
}) {
  const renameThread = useSessionStore((s) => s.renameThread);
  const requestTeardown = useSessionStore((s) => s.requestTeardown);
  const [editing, setEditing] = useState(false);

  // A div, not a button: the hover actions nest inside the clickable row.
  // tabIndex + keydown keep it keyboard-reachable like the button it replaced.
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => {
        if (!editing) onSelect();
      }}
      onKeyDown={(e) => {
        if (editing || e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "group flex w-full cursor-pointer items-start gap-2 rounded-md py-1.5 pr-2 pl-3 text-left transition-colors",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : open
            ? "bg-sidebar-accent/40 text-sidebar-foreground hover:bg-sidebar-accent/60"
            : "text-sidebar-foreground hover:bg-sidebar-accent/50",
      )}
    >
      <Sparkle
        className={cn(
          "mt-0.5 size-3.5 shrink-0",
          isAgent
            ? "text-agent"
            : active || open
              ? "text-brand"
              : "text-muted-foreground",
        )}
      />
      <span className="min-w-0 flex-1">
        {editing ? (
          <InlineRename
            initial={thread.title}
            onCommit={(value) => renameThread(thread.id, value)}
            onClose={() => setEditing(false)}
            className="block w-full text-sm leading-tight"
          />
        ) : (
          <span className="block truncate text-sm leading-tight">
            {thread.title}
          </span>
        )}
        <span className="mt-0.5 block text-[11px] tabular-nums text-muted-foreground">
          {formatRelativeTime(thread.updatedAt)}
        </span>
      </span>

      {!editing && (
        <span className="flex shrink-0 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-6 text-muted-foreground hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditing(true);
                }}
                aria-label="Rename thread"
              >
                <Pencil className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Rename Thread</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-6 text-muted-foreground hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  requestTeardown("archive", thread.id);
                }}
                aria-label="Archive thread"
              >
                <Archive className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Archive Thread</TooltipContent>
          </Tooltip>
        </span>
      )}
    </div>
  );
}

