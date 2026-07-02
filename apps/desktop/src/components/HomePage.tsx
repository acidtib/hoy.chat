import { useMemo } from "react";
import { FolderPlus, Plus, Sparkle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSessionStore } from "@/state/store";
import { usePrefsStore } from "@/state/prefs";
import { pickDirectory } from "@/lib/ipc";
import { formatRelativeTime } from "@/lib/utils";

// The home screen shown when no thread panel is open. It is a launcher, not a
// splash: the fastest paths to value (resume a recent thread, start a new one,
// open a project) fill the space instead of a single heading over a void.
const MAX_RECENTS = 6;

export function HomePage() {
  const projects = useSessionStore((s) => s.projects);
  const addThread = useSessionStore((s) => s.addThread);
  const addProject = useSessionStore((s) => s.addProject);
  const openThread = useSessionStore((s) => s.openThread);

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

  // New threads land in the project of the most recent thread, else the first
  // project. Null when there is no project yet (first run).
  const targetProjectId = recents[0]?.project.id ?? projects[0]?.id ?? null;

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
            <Button size="sm" onClick={() => addThread(targetProjectId)}>
              <Plus className="size-4" />
              New thread
            </Button>
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
