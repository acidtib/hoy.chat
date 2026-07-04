import { useMemo, useState } from "react";
import { Check, ChevronDown, FolderPlus, GitBranch, Sparkle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HomeComposer } from "@/components/home/HomeComposer";
import { useSessionStore } from "@/state/store";
import { usePrefsStore } from "@/state/prefs";
import { pickDirectory } from "@/lib/ipc";
import { cn, formatRelativeTime } from "@/lib/utils";

// The home screen shown when no thread panel is open and the body is not the
// fleet/usage view (HOY-264). A clean "start a new thread" hero built on the
// real composer; usage stats live in their own Usage view.
const MAX_RECENTS = 6;

export function HomePage() {
  const projects = useSessionStore((s) => s.projects);
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const addProject = useSessionStore((s) => s.addProject);
  const openThread = useSessionStore((s) => s.openThread);
  const setActiveProject = useSessionStore((s) => s.setActiveProject);

  const [picked, setPicked] = useState<string | null>(null);

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

  const hasTarget = !!targetProject && !!targetProjectId;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto bg-background">
      <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col items-center justify-center px-8 py-16">
        <h1 className="mb-6 text-center text-2xl font-semibold tracking-tight text-foreground">
          Start a new thread
        </h1>

        {hasTarget ? (
          <div className="w-full">
            {/* One bordered card: project/branch header divider + real composer. */}
            <div className="border border-border bg-card">
            {/* Composer header: project pill (functional) + branch pill (mock). */}
            <div className="flex items-center gap-3 border-b border-border px-3 py-2 text-xs">
              {projects.length > 1 ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button className="inline-flex items-center gap-1.5 text-foreground">
                      <span className="max-w-[12rem] truncate">
                        {targetProject.name}
                      </span>
                      <ChevronDown className="size-3.5 text-muted-foreground" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="min-w-52">
                    <DropdownMenuLabel>Project</DropdownMenuLabel>
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
                            p.id === targetProjectId ? "opacity-100" : "opacity-0",
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
              ) : (
                <span className="text-foreground">{targetProject.name}</span>
              )}

              {/* Mocked branch pill: git switching is not wired (HOY-264). */}
              <span
                className="inline-flex items-center gap-1.5 text-muted-foreground"
                title="Branch switching is not available yet"
              >
                <GitBranch className="size-3.5" />
                main
                <ChevronDown className="size-3.5" />
              </span>
            </div>

              <HomeComposer
                projectId={targetProjectId}
                projectPath={targetProject.path ?? null}
              />
            </div>

            {recents.length > 0 && (
              <div className="mt-8 space-y-2">
                <p className="px-1 text-xs font-medium text-muted-foreground">
                  Recent
                </p>
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
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4">
            <p className="max-w-md text-center text-sm text-muted-foreground">
              Open a project directory to start. Each project holds its own
              threads, and every thread is a conversation with the agent running
              in that working directory.
            </p>
            <Button onClick={() => void handleOpenProject()}>
              <FolderPlus className="size-4" />
              Open project
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
