import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  Check,
  ChevronDown,
  ExternalLink,
  GripVertical,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { linearTeams } from "@/lib/ipc";
import { agentThreads, unassignedIssues } from "@/lib/delegate";
import type {
  LinearIssue,
  LinearTeam,
  Project,
  SubagentDef,
  Thread,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { EMPTY_ISSUES, useLinearStore } from "@/state/linear";
import { useSessionStore } from "@/state/store";

const ISSUE_MIME = "application/x-hoy-linear-issue";

// HOY-346: a project's Fleet. Open Linear issues on the left, agents on the
// right with everything they are working on. Dropping an issue on an agent
// starts a thread running as that agent.
export function ProjectFleet({ project }: { project: Project }) {
  const status = useLinearStore((s) => s.status);
  const refreshStatus = useLinearStore((s) => s.refreshStatus);

  useEffect(() => {
    if (!status) void refreshStatus();
  }, [status, refreshStatus]);

  return <BoardBody project={project} />;
}

function BoardBody({ project }: { project: Project }) {
  const status = useLinearStore((s) => s.status);
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);

  if (!status) {
    return <Notice title="Checking Linear..." />;
  }
  if (!status.connected || status.error) {
    return (
      <Notice
        title={status.error ? "Linear needs attention" : "Connect Linear"}
        body={
          status.error ??
          "Connect a Linear workspace to pull issues into the board."
        }
        action={
          <Button
            size="sm"
            onClick={() => setSettingsOpen(true, "integrations")}
          >
            Open Integrations
          </Button>
        }
      />
    );
  }
  if (!project.linear) {
    return <TeamLink project={project} />;
  }
  return <Board project={project} teamId={project.linear.teamId} />;
}

function Board({ project, teamId }: { project: Project; teamId: string }) {
  const cache = useLinearStore((s) => s.issues[project.id] ?? EMPTY_ISSUES);
  const refreshIssues = useLinearStore((s) => s.refreshIssues);
  const subagents = useSessionStore((s) => s.subagents);
  const refreshSubagents = useSessionStore((s) => s.refreshSubagents);
  const delegateIssue = useSessionStore((s) => s.delegateIssue);

  useEffect(() => {
    if (cache.fetchedAt === null && !cache.loading && !cache.error) {
      void refreshIssues(project.id, teamId);
    }
  }, [
    cache.fetchedAt,
    cache.loading,
    cache.error,
    project.id,
    teamId,
    refreshIssues,
  ]);

  useEffect(() => {
    if (subagents.length === 0) void refreshSubagents(project.path ?? "");
  }, [subagents.length, project.path, refreshSubagents]);

  const agents = useMemo(() => subagents.filter((d) => d.enabled), [subagents]);
  const open = useMemo(
    () => unassignedIssues(cache.items, project.threads),
    [cache.items, project.threads],
  );

  const assign = (issueId: string, agent: string) => {
    const issue = cache.items.find((i) => i.id === issueId);
    if (issue) delegateIssue(project.id, issue, agent);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-3 px-4 pt-3 text-xs text-muted-foreground">
        <span>Drag an issue onto an agent to start it</span>
        <div className="ml-auto flex items-center gap-3">
          <Mock className="font-mono">$-- in queues</Mock>
          <Mock className="flex items-center gap-1.5 border-l border-border pl-3">
            Auto
            <Switch disabled aria-label="Auto assign (mock)" />
          </Mock>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 gap-4 p-4 pt-2">
        <section className="flex w-80 shrink-0 flex-col border border-border bg-card/40">
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
            <h2 className="text-sm font-semibold">Unassigned</h2>
            <span className="border border-border px-1.5 text-[11px] tabular-nums text-muted-foreground">
              {open.length}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              className="ml-auto size-7 text-muted-foreground"
              onClick={() => void refreshIssues(project.id, teamId)}
              disabled={cache.loading}
              aria-label="Refresh issues"
              title="Refresh issues"
            >
              <RefreshCw
                className={cn("size-3.5", cache.loading && "animate-spin")}
              />
            </Button>
          </div>
          <div className="scrollbar-thin flex-1 space-y-2 overflow-y-auto p-2">
            {cache.error ? (
              <p className="p-2 text-xs text-destructive">{cache.error}</p>
            ) : cache.fetchedAt === null ? (
              <p className="p-2 text-xs text-muted-foreground">
                Loading issues...
              </p>
            ) : open.length === 0 ? (
              <p className="p-2 text-xs text-muted-foreground">
                {cache.items.length === 0
                  ? "No backlog or Todo issues in this team."
                  : "Everything is handed out."}
              </p>
            ) : (
              open.map((issue) => (
                <IssueCard
                  key={issue.id}
                  issue={issue}
                  agents={agents}
                  onAssign={(agent) => assign(issue.id, agent)}
                />
              ))
            )}
          </div>
        </section>

        <section className="flex min-w-0 flex-1 flex-col border border-border bg-card/40">
          <div className="flex h-11 shrink-0 items-center border-b border-border px-3">
            <h2 className="text-sm font-semibold">Agents</h2>
          </div>
          <div className="scrollbar-thin flex-1 divide-y divide-border overflow-y-auto">
            {agents.length === 0 ? (
              <p className="p-3 text-xs text-muted-foreground">
                No enabled agents. Add or enable one in Settings, Subagents.
              </p>
            ) : (
              agents.map((def) => (
                <AgentRow
                  key={def.name}
                  def={def}
                  threads={agentThreads(project.threads, def.name)}
                  onDropIssue={(issueId) => assign(issueId, def.name)}
                />
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function IssueCard({
  issue,
  agents,
  onAssign,
}: {
  issue: LinearIssue;
  agents: SubagentDef[];
  onAssign: (agent: string) => void;
}) {
  const [dragging, setDragging] = useState(false);
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(ISSUE_MIME, issue.id);
        e.dataTransfer.effectAllowed = "move";
        setDragging(true);
      }}
      onDragEnd={() => setDragging(false)}
      data-issue-id={issue.id}
      className={cn(
        "group/issue cursor-grab border border-border bg-card p-2.5 active:cursor-grabbing",
        dragging && "opacity-40",
      )}
    >
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <GripVertical className="-ml-1 size-3.5 shrink-0 opacity-50" />
        <span className="font-mono">{issue.identifier}</span>
        {issue.estimate !== null && (
          <span className="font-mono">{issue.estimate} pt</span>
        )}
        <span
          className={cn(
            "ml-auto",
            issue.priority === 1 && "text-destructive",
            issue.priority === 2 && "text-amber-500",
          )}
        >
          {issue.priority === 0 ? issue.stateName : issue.priorityLabel}
        </span>
      </div>
      <p className="mt-1 text-sm leading-snug text-foreground">{issue.title}</p>
      <div className="mt-2 flex items-center gap-1 text-[11px] text-muted-foreground">
        <span className="min-w-0 truncate">
          {issue.labels.length > 0 ? issue.labels.join(" · ") : issue.stateName}
        </span>
        <button
          type="button"
          onClick={() => void openUrl(issue.url)}
          className="ml-auto flex size-6 shrink-0 items-center justify-center opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/issue:opacity-100"
          aria-label={`Open ${issue.identifier} in Linear`}
          title="Open in Linear"
        >
          <ExternalLink className="size-3.5" />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex h-6 shrink-0 items-center gap-0.5 px-1.5 opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/issue:opacity-100 data-[state=open]:opacity-100"
              aria-label={`Assign ${issue.identifier}`}
            >
              Assign
              <ChevronDown className="size-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            <DropdownMenuLabel>Assign to</DropdownMenuLabel>
            {agents.map((def) => (
              <DropdownMenuItem
                key={def.name}
                onSelect={() => onAssign(def.name)}
              >
                <Bot className="size-4" />
                {def.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function AgentRow({
  def,
  threads,
  onDropIssue,
}: {
  def: SubagentDef;
  threads: Thread[];
  onDropIssue: (issueId: string) => void;
}) {
  const streaming = useSessionStore((s) => s.streaming);
  const [over, setOver] = useState(false);
  const working = threads.some((t) => streaming[t.id]);

  return (
    <div
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(ISSUE_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null))
          setOver(false);
      }}
      onDrop={(e) => {
        setOver(false);
        const id = e.dataTransfer.getData(ISSUE_MIME);
        if (id) {
          e.preventDefault();
          onDropIssue(id);
        }
      }}
      data-agent={def.name}
      className={cn(
        "p-3 outline outline-1 -outline-offset-1 outline-transparent transition-colors",
        over && "bg-brand/5 outline-brand",
      )}
    >
      <div className="flex items-center gap-2.5">
        <div className="flex size-7 shrink-0 items-center justify-center border border-border bg-background text-agent">
          <Bot className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="text-sm font-semibold">{def.name}</span>
            <span className="truncate text-xs text-muted-foreground">
              {def.model ?? "Default model"}
            </span>
            <Mock className="font-mono text-xs">$--/min</Mock>
          </div>
          {def.description && (
            <p className="truncate text-xs text-muted-foreground">
              {def.description}
            </p>
          )}
        </div>
        {over && (
          <Mock className="shrink-0 font-mono text-xs text-brand">
            +$-- · +--m
          </Mock>
        )}
        <span
          className={cn(
            "flex shrink-0 items-center gap-1.5 text-xs",
            working ? "text-muted-foreground" : "text-emerald-500",
          )}
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              working ? "bg-muted-foreground/60" : "bg-emerald-500",
            )}
          />
          {working ? (
            <>
              Busy until <Mock className="font-mono">--</Mock>
            </>
          ) : (
            "Free"
          )}
        </span>
      </div>
      {threads.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5 pl-9.5">
          {threads.map((t) => (
            <WorkChip key={t.id} thread={t} running={!!streaming[t.id]} />
          ))}
        </div>
      )}
    </div>
  );
}

// One piece of an agent's work: a delegated issue, or a subagent another
// thread spawned.
function WorkChip({ thread, running }: { thread: Thread; running: boolean }) {
  const openThread = useSessionStore((s) => s.openThread);
  const issue = thread.linearIssue;
  return (
    <button
      type="button"
      onClick={() => openThread(thread.id)}
      title={issue ? `${issue.identifier} ${issue.title}` : thread.title}
      className={cn(
        "flex h-6 max-w-72 items-center gap-1.5 border px-2 text-xs transition-colors",
        running
          ? "border-brand/30 bg-brand/10 text-foreground hover:bg-brand/15"
          : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {running ? (
        <Loader2 className="size-3 shrink-0 animate-spin text-brand" />
      ) : (
        <Check className="size-3 shrink-0" />
      )}
      {issue && <span className="font-mono text-[11px]">{issue.identifier}</span>}
      <span className="truncate">{issue ? issue.title : thread.title}</span>
    </button>
  );
}

function TeamLink({ project }: { project: Project }) {
  const setProjectLinear = useSessionStore((s) => s.setProjectLinear);
  const [teams, setTeams] = useState<LinearTeam[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    linearTeams().then(
      (t) => !cancelled && setTeams(t),
      (e) => !cancelled && setError(String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Notice
      title={`Link ${project.name} to a Linear team`}
      body="Its backlog and Todo issues become the Unassigned column."
      action={
        error ? (
          <p className="text-xs text-destructive">{error}</p>
        ) : !teams ? (
          <p className="text-xs text-muted-foreground">Loading teams...</p>
        ) : teams.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No teams in this workspace.
          </p>
        ) : (
          <div className="flex w-full max-w-sm flex-col border border-border">
            {teams.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() =>
                  setProjectLinear(project.id, {
                    teamId: t.id,
                    teamKey: t.key,
                    teamName: t.name,
                  })
                }
                className="flex items-center gap-2 border-b border-border px-3 py-2 text-left text-sm last:border-b-0 hover:bg-accent"
              >
                <span className="font-mono text-xs text-muted-foreground">
                  {t.key}
                </span>
                {t.name}
              </button>
            ))}
          </div>
        )
      }
    />
  );
}

export function TeamMenu({ project }: { project: Project }) {
  const setProjectLinear = useSessionStore((s) => s.setProjectLinear);
  const link = project.linear!;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs">
          <span className="font-mono text-muted-foreground">
            {link.teamKey}
          </span>
          {link.teamName}
          <ChevronDown className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Linear team</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => setProjectLinear(project.id, null)}>
          Unlink team
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Placeholder for a board value that is not computed yet (cost, ETA, Auto).
function Mock({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      title="Mock: not wired yet"
      className={cn("text-muted-foreground/70", className)}
    >
      {children}
    </span>
  );
}

function Notice({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <h2 className="text-sm font-semibold">{title}</h2>
        {body && <p className="text-xs text-muted-foreground">{body}</p>}
        {action}
      </div>
    </div>
  );
}
