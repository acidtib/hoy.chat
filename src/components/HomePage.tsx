import { useMemo } from "react";
import { Settings, Sparkle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn, formatRelativeTime } from "@/lib/utils";
import { useSessionStore } from "@/state/store";

export function HomePage({ onOpenSettings }: { onOpenSettings: () => void }) {
  const projects = useSessionStore((s) => s.projects);
  const setActiveThreadId = useSessionStore((s) => s.setActiveThreadId);

  const recent = useMemo(() => {
    return projects
      .flatMap((p) => p.threads.map((t) => ({ project: p.name, thread: t })))
      .sort((a, b) => b.thread.updatedAt - a.thread.updatedAt)
      .slice(0, 6);
  }, [projects]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <header className="flex h-14 shrink-0 items-center justify-end px-4">
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground"
          onClick={onOpenSettings}
          aria-label="Settings"
        >
          <Settings className="size-4" />
        </Button>
      </header>

      <div className="scrollbar-thin flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-xl flex-col items-center px-6 py-20 text-center">
          <div className="flex size-14 items-center justify-center rounded-2xl bg-brand/10 ring-1 ring-inset ring-brand/20">
            <span className="text-2xl font-semibold leading-none text-brand">
              H
            </span>
          </div>
          <h1 className="mt-5 text-2xl font-semibold tracking-tight text-foreground">
            Hoy Desktop
          </h1>
          <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
            Pick a project in the sidebar and start a new thread, or jump back
            into a recent one.
          </p>

          {recent.length > 0 && (
            <div className="mt-10 w-full text-left">
              <h2 className="px-1 pb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Recent threads
              </h2>
              <ul className="flex flex-col gap-1">
                {recent.map(({ project, thread }) => (
                  <li key={thread.id}>
                    <button
                      onClick={() => setActiveThreadId(thread.id)}
                      className={cn(
                        "group flex w-full items-center gap-3 rounded-xl border border-border bg-card/50 px-4 py-3 text-left transition-colors hover:border-ring/50 hover:bg-card",
                      )}
                    >
                      <Sparkle className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-foreground">
                          {thread.title}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {project}
                        </span>
                      </span>
                      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                        {formatRelativeTime(thread.updatedAt)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
