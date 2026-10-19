import { useEffect, useMemo, useRef } from "react";
import { FolderKanban, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThreadModelIcon } from "@/components/ThreadModelIcon";
import { cn } from "@/lib/utils";
import { childThreadIdsOf, isSubagentThread } from "@/state/delivery";
import { findThread, groupTabs, useSessionStore } from "@/state/store";

// The tab strip in the title bar: the active project's home pinned first, then
// one tab per group of split panels. A thread tab is labeled by the active
// thread when it holds it, else its first panel. `activeKey` is null while the
// project home is showing. The active tab overlaps the bar's bottom border so
// it reads as part of the body below.
export function ThreadTabs({ activeKey }: { activeKey: string | null }) {
  const panels = useSessionStore((s) => s.panels);
  const activeThreadId = useSessionStore((s) => s.activeThreadId);
  const tabs = useMemo(() => groupTabs(panels), [panels]);
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const addThread = useSessionStore((s) => s.addThread);

  const stripRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    stripRef.current
      ?.querySelector<HTMLElement>(`[data-tab-key="${activeKey}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeKey, tabs.length]);

  return (
    <div className="-mb-px flex min-w-0 flex-1 items-stretch">
      <ProjectTab />
      <div
        ref={stripRef}
        role="tablist"
        className="scrollbar-thin flex min-w-0 items-stretch overflow-x-auto"
      >
        {tabs.map((tab) => {
          const ids = tab.panels.map((p) => p.id);
          return (
            <ThreadTab
              key={tab.key}
              tabKey={tab.key}
              threadId={
                activeThreadId && ids.includes(activeThreadId)
                  ? activeThreadId
                  : ids[0]
              }
              threadIds={ids}
              active={tab.key === activeKey}
            />
          );
        })}
      </div>
      {activeProjectId && (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => addThread(activeProjectId)}
          aria-label="New Thread"
          title="New Thread"
          className="my-auto ml-0.5 size-7 shrink-0 text-muted-foreground hover:text-foreground"
        >
          <Plus className="size-4" />
        </Button>
      )}
      <div data-tauri-drag-region className="min-w-8 flex-1 border-b border-border" />
    </div>
  );
}

function ProjectTab() {
  const project = useSessionStore(
    (s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null,
  );
  const active = useSessionStore((s) => s.bodyView === "project");
  const projectView = useSessionStore((s) => s.projectView);
  const openProject = useSessionStore((s) => s.openProject);
  if (!project) return null;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={() => openProject(project.id, projectView)}
      title={`${project.name} home`}
      className={cn(
        "flex max-w-48 shrink-0 items-center gap-1.5 border-r border-b border-t-2 border-r-border px-2.5 text-xs font-medium transition-colors",
        active
          ? "border-t-brand/70 border-b-background bg-background text-foreground"
          : "border-t-transparent border-b-border text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground",
      )}
    >
      <FolderKanban className="size-3.5 shrink-0" />
      <span className="truncate">{project.name}</span>
    </button>
  );
}

function ThreadTab({
  tabKey,
  threadId,
  threadIds,
  active,
}: {
  tabKey: string;
  threadId: string;
  threadIds: string[];
  active: boolean;
}) {
  const thread = useSessionStore(
    (s) => findThread(s.projects, threadId)?.thread ?? null,
  );
  const isAgent = useSessionStore((s) => {
    const found = findThread(s.projects, threadId);
    return found
      ? isSubagentThread(found.thread) ||
          childThreadIdsOf(s.projects, threadId).length > 0
      : false;
  });
  const streaming = useSessionStore((s) =>
    threadIds.some((id) => s.streaming[id]),
  );
  const defaultModel = useSessionStore((s) => s.defaultModel);
  const openThread = useSessionStore((s) => s.openThread);
  const requestPanelClose = useSessionStore((s) => s.requestPanelClose);

  const isUnstarted = !!thread && !thread.sessionFile && !thread.sessionId;
  const iconModel = thread?.model ?? (isUnstarted ? defaultModel : null);
  const title = thread?.title ?? "Thread";
  const closeTab = () => {
    for (const id of threadIds) requestPanelClose(id);
  };

  return (
    <div
      role="tab"
      tabIndex={0}
      aria-selected={active}
      data-tab-key={tabKey}
      title={title}
      onClick={() => openThread(threadId)}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          closeTab();
        }
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openThread(threadId);
        }
      }}
      className={cn(
        "group/tab flex w-48 min-w-28 shrink cursor-pointer items-center gap-1.5 border-r border-b border-t-2 border-r-border pr-1 pl-2.5 text-xs transition-colors",
        active
          ? "border-b-background bg-background text-foreground"
          : "border-t-transparent border-b-border text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground",
        active && (isAgent ? "border-t-agent/80" : "border-t-brand/70"),
      )}
    >
      <ThreadModelIcon
        model={iconModel}
        className={cn(
          "size-3.5 shrink-0",
          isAgent ? "text-agent" : "text-muted-foreground",
        )}
      />
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {threadIds.length > 1 && (
        <span
          title={`${threadIds.length} panels`}
          className="shrink-0 border border-border px-1 text-[10px] leading-4 tabular-nums text-muted-foreground"
        >
          {threadIds.length}
        </span>
      )}
      {streaming && (
        <span
          aria-label="Streaming"
          className="size-1.5 shrink-0 animate-pulse bg-brand group-hover/tab:hidden"
        />
      )}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          closeTab();
        }}
        aria-label="Close Tab"
        title="Close Tab"
        className={cn(
          "flex size-5 shrink-0 items-center justify-center text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
          active ? "" : "opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100",
          streaming && "hidden group-hover/tab:flex",
        )}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
