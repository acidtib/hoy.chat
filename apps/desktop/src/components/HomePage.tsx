import { useMemo, useState } from "react";
import { Check, ChevronDown, FolderPlus, Plus, Sparkle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSessionStore } from "@/state/store";
import { usePrefsStore } from "@/state/prefs";
import { pickDirectory } from "@/lib/ipc";
import { cn, formatRelativeTime } from "@/lib/utils";

// The home screen shown when no thread panel is open. It is a launcher, not a
// splash: the fastest paths to value (resume a recent thread, start a new one,
// open a project) fill the space instead of a single heading over a void.
const MAX_RECENTS = 6;

export function HomePage() {
  const projects = useSessionStore((s) => s.projects);
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const addThread = useSessionStore((s) => s.addThread);
  const addProject = useSessionStore((s) => s.addProject);
  const openThread = useSessionStore((s) => s.openThread);
  const setActiveProject = useSessionStore((s) => s.setActiveProject);

  // Explicit pick from the project chooser; overrides the default target until
  // the user changes it. Cleared implicitly when it no longer resolves.
  const [picked, setPicked] = useState<string | null>(null);

  // Most recently touched non-archived threads across all projects, each tagged
  // with its project for context.
  const recents = useMemo(() => {
    const rows = projects.flatMap((p) =>
      p.threads
        .filter((t) => !t.archived)
        .map((t) => ({ thread: t, project: p })),
    );
    rows.sort((a, b) => b.thread.updatedAt - a.thread.updatedAt);
    return rows.slice(0, MAX_RECENTS);
  }, [projects]);

  const exists = (id: string | null) =>
    !!id && projects.some((p) => p.id === id);

  // Target project for a new thread, in priority order: the user's explicit
  // pick, then the last project they worked in, then the most recent thread's
  // project, then the first project. Each is validated so a stale id (removed
  // project) falls through.
  const targetProjectId =
    (exists(picked) ? picked : null) ??
    (exists(activeProjectId) ? activeProjectId : null) ??
    recents[0]?.project.id ??
    projects[0]?.id ??
    null;

  const targetProject = projects.find((p) => p.id === targetProjectId) ?? null;

  async function handleOpenProject() {
    const dir = await pickDirectory(
      usePrefsStore.getState().defaultProjectDir || undefined,
    );
    if (dir) addProject(dir);
  }

  const hasProjects = projects.length > 0;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto bg-background">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-8 pb-16 pt-14">
        <div className="flex items-center gap-2.5">
          <Sparkle className="size-[18px] text-brand" />
          <h1 className="text-lg font-semibold tracking-tight text-foreground">
            Threads
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {hasProjects && targetProjectId && (
            <>
              <Button size="sm" onClick={() => addThread(targetProjectId)}>
                <Plus className="size-4" />
                New thread
              </Button>
              {/* Choose which project the new thread lands in. Shown only with
                  more than one project; otherwise the target is unambiguous. */}
              {projects.length > 1 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="gap-1.5">
                      <span className="text-muted-foreground">in</span>
                      <span className="max-w-[10rem] truncate">
                        {targetProject?.name}
                      </span>
                      <ChevronDown className="size-3.5 text-muted-foreground" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="min-w-52">
                    <DropdownMenuLabel>New thread in</DropdownMenuLabel>
                    {projects.map((p) => (
                      <DropdownMenuItem
                        key={p.id}
                        onSelect={() => {
                          setPicked(p.id);
                          setActiveProject(p.id);
                        }}
                      >
                        <Check
                          className={cn(
                            "size-4",
                            p.id === targetProjectId
                              ? "opacity-100"
                              : "opacity-0",
                          )}
                        />
                        <span className="truncate">{p.name}</span>
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => void handleOpenProject()}>
                      <FolderPlus className="size-4" />
                      Open project...
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </>
          )}
          <Button
            variant={hasProjects ? "outline" : "default"}
            size="sm"
            onClick={() => void handleOpenProject()}
          >
            <FolderPlus className="size-4" />
            Open project
          </Button>
        </div>

        {hasProjects ? (
          <div className="space-y-2">
            <p className="px-1 text-xs font-medium text-muted-foreground">
              Recent
            </p>
            {recents.length > 0 ? (
              <div className="divide-y divide-border border border-border">
                {recents.map(({ thread, project }) => (
                  <button
                    key={thread.id}
                    type="button"
                    onClick={() => openThread(thread.id)}
                    className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-accent/40 focus-visible:relative focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60"
                  >
                    <Sparkle className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {thread.title}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {project.name}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      {formatRelativeTime(thread.updatedAt)}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="border border-border px-4 py-8 text-center text-sm text-muted-foreground">
                No threads yet. Start one to put the agent to work.
              </div>
            )}
          </div>
        ) : (
          <p className="max-w-md text-sm text-muted-foreground">
            Open a project directory to start. Each project holds its own threads,
            and every thread is a conversation with the agent running in that
            working directory.
          </p>
        )}
      </div>
    </div>
  );
}
