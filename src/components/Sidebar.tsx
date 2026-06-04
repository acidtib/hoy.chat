import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  MoreHorizontal,
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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn, formatRelativeTime } from "@/lib/utils";
import { pickDirectory } from "@/lib/ipc";
import { useSessionStore } from "@/state/store";
import type { Project, Thread } from "@/lib/types";

export function Sidebar() {
  const projects = useSessionStore((s) => s.projects);
  const activeThreadId = useSessionStore((s) => s.activeThreadId);
  const setActiveThreadId = useSessionStore((s) => s.setActiveThreadId);
  const addProject = useSessionStore((s) => s.addProject);
  const addThread = useSessionStore((s) => s.addThread);
  const removeProject = useSessionStore((s) => s.removeProject);
  const sidebarWidth = useSessionStore((s) => s.sidebarWidth);

  async function handleOpenProject() {
    const dir = await pickDirectory();
    if (dir) addProject(dir);
  }

  const [query, setQuery] = useState("");
  const normalized = query.trim().toLowerCase();

  const filtered = useMemo(() => {
    if (!normalized) return projects;
    return projects
      .map((p) => {
        const nameMatch = p.name.toLowerCase().includes(normalized);
        const threads = nameMatch
          ? p.threads
          : p.threads.filter((t) =>
              t.title.toLowerCase().includes(normalized),
            );
        return { project: p, threads, keep: nameMatch || threads.length > 0 };
      })
      .filter((x) => x.keep)
      .map((x) => ({ ...x.project, threads: x.threads }));
  }, [projects, normalized]);

  return (
    <aside
      style={{ width: sidebarWidth }}
      className="relative flex shrink-0 flex-col border-r border-border bg-sidebar"
    >
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
                    searching={normalized.length > 0}
                    onSelectThread={setActiveThreadId}
                    onNewThread={() => addThread(project.id)}
                    onRemove={() => removeProject(project.id)}
                  />
                ))}
              </ul>
            )}
          </nav>
        </>
      )}

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

// Drag the sidebar's right edge to resize; the store clamps to min/max. Listeners
// and the global drag cursor live in an effect keyed on `dragging`, so they tear
// down on pointerup/cancel AND on unmount (e.g. the sidebar collapses mid-drag) -
// never leaking past the drag or leaving the cursor stuck.
function ResizeHandle() {
  const setSidebarWidth = useSessionStore((s) => s.setSidebarWidth);
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, width: 0 });

  useEffect(() => {
    if (!dragging) return;
    function onMove(ev: PointerEvent) {
      setSidebarWidth(dragStart.current.width + (ev.clientX - dragStart.current.x));
    }
    function stop() {
      setDragging(false);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
  }, [dragging, setSidebarWidth]);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    dragStart.current = {
      x: e.clientX,
      width: useSessionStore.getState().sidebarWidth,
    };
    setDragging(true);
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
  searching,
  onSelectThread,
  onNewThread,
  onRemove,
}: {
  project: Project;
  activeThreadId: string | null;
  searching: boolean;
  onSelectThread: (id: string) => void;
  onNewThread: () => void;
  onRemove: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const expanded = searching || !collapsed;

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
              <DropdownMenuItem variant="destructive" onSelect={onRemove}>
                <Trash2 />
                Remove project
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {expanded && (
        <div className="mt-0.5 flex flex-col gap-0.5 pb-1">
          {project.threads.length === 0 ? (
            <p className="px-2.5 py-1 pl-7 text-xs text-muted-foreground/70">
              No threads yet
            </p>
          ) : (
            project.threads.map((thread) => (
              <ThreadRow
                key={thread.id}
                thread={thread}
                active={thread.id === activeThreadId}
                onSelect={() => onSelectThread(thread.id)}
              />
            ))
          )}
        </div>
      )}
    </li>
  );
}

function ThreadRow({
  thread,
  active,
  onSelect,
}: {
  thread: Thread;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={cn(
        "group flex w-full cursor-pointer items-start gap-2 rounded-md py-1.5 pl-3 pr-2 text-left transition-colors",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground hover:bg-sidebar-accent/50",
      )}
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
        <span className="mt-0.5 block text-[11px] tabular-nums text-muted-foreground">
          {formatRelativeTime(thread.updatedAt)}
        </span>
      </span>
    </button>
  );
}

