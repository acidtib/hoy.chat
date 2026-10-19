import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Archive,
  ArrowDown,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  ExternalLink,
  GripVertical,
  Inbox,
  Loader2,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Square,
  X,
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
import {
  costPerMinute,
  estimateMinutes,
  finishedRuns,
  forecast,
  formatClock,
  formatCost,
  formatMinutes,
  haltingThread,
  openRuns,
  queueOf,
  type AgentForecast,
} from "@/lib/fleet";
import type {
  LinearIssue,
  LinearTeam,
  Project,
  QueuedIssue,
  SubagentDef,
  Thread,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { EMPTY_ISSUES, useLinearStore } from "@/state/linear";
import { useSessionStore } from "@/state/store";

const ISSUE_MIME = "application/x-hoy-linear-issue";

// HOY-346: a project's Fleet. Open Linear issues on the left, agents on the
// right with everything they are working on. Dropping an issue on an agent
// queues it; it starts as a thread running as that agent once a slot is free
// (HOY-350).
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
  const enqueueIssue = useSessionStore((s) => s.enqueueIssue);
  const projects = useSessionStore((s) => s.projects);
  const [dragged, setDragged] = useState<LinearIssue | null>(null);
  const now = useNow(30_000);

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
  const queue = project.fleet?.queue ?? EMPTY_QUEUE;

  // An agent may have closed its issue or filed follow-ups: re-read the
  // backlog whenever a delegated thread stops running.
  const running = useSessionStore(
    (s) => project.threads.filter((t) => t.linearIssue && s.streaming[t.id]).length,
  );
  const prevRunning = useRef(running);
  useEffect(() => {
    if (running < prevRunning.current) void refreshIssues(project.id, teamId);
    prevRunning.current = running;
  }, [running, project.id, teamId, refreshIssues]);
  const open = useMemo(
    () => unassignedIssues(cache.items, project.threads, queue),
    [cache.items, project.threads, queue],
  );

  // History spans every project: an agent's pace is not project specific.
  const allThreads = useMemo(() => projects.flatMap((p) => p.threads), [projects]);
  const plans = useMemo(
    () =>
      new Map(
        agents.map((def) => [
          def.name,
          agentPlan(project, allThreads, def.name, now),
        ]),
      ),
    [agents, project, allThreads, now],
  );
  const total = [...plans.values()].reduce(
    (sum, p) => (p.rate == null ? sum : sum + p.forecast.minutesLeft * p.rate),
    0,
  );
  const unpriced = [...plans.values()].some(
    (p) => p.rate == null && p.forecast.minutesLeft > 0,
  );

  const assign = (issueId: string, agent: string) => {
    const issue = cache.items.find((i) => i.id === issueId);
    if (issue) enqueueIssue(project.id, issue, agent);
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-3 px-4 pt-3 text-xs text-muted-foreground">
        <GripVertical className="size-3.5 shrink-0 opacity-50" />
        <span className="truncate">Drag an issue onto an agent to queue it</span>
        <div className="ml-auto flex shrink-0 items-center gap-3">
          <span
            className="font-mono"
            title={
              unpriced
                ? "Estimate. Agents with no finished runs yet are not counted."
                : "Estimate from each agent's finished runs."
            }
          >
            {total > 0 ? `~${formatCost(total)}${unpriced ? "+" : ""}` : unpriced ? "$--" : "$0"}{" "}
            in queues
          </span>
          <Mock className="flex items-center gap-1.5 border-l border-border pl-3">
            Auto
            <Switch disabled aria-label="Auto assign (mock)" />
          </Mock>
        </div>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 gap-3 p-4 pt-2">
        <Column
          title="Backlog"
          count={open.length}
          className="w-72"
          action={
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-7 text-muted-foreground"
              onClick={() => void refreshIssues(project.id, teamId)}
              disabled={cache.loading}
              aria-label="Refresh issues"
              title="Refresh issues"
            >
              <RefreshCw
                className={cn("size-3.5", cache.loading && "animate-spin")}
              />
            </Button>
          }
        >
          <div className="space-y-2 p-2">
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
                  onDrag={(d) => setDragged(d ? issue : null)}
                />
              ))
            )}
          </div>
        </Column>

        <Column
          title="Todo"
          count={0}
          className="hidden w-72 xl:flex"
          action={
            <Mock className="text-[11px]">Preview</Mock>
          }
        >
          <div className="flex h-full flex-col p-2">
            <div
              title="Mock: not wired yet"
              className="mt-auto flex flex-col items-center gap-2 border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground/70"
            >
              <Inbox className="size-4" />
              Drop issues here to plan them
            </div>
          </div>
        </Column>

        <Column title="Agents" count={agents.length} className="min-w-80 flex-1">
          {agents.length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground">
              No enabled agents. Add or enable one in Settings, Subagents.
            </p>
          ) : (
            <div className="divide-y divide-border">
              {agents.map((def) => (
                <AgentRow
                  key={def.name}
                  def={def}
                  project={project}
                  plan={plans.get(def.name)!}
                  dragged={dragged}
                  now={now}
                  onDropIssue={(issueId) => assign(issueId, def.name)}
                />
              ))}
            </div>
          )}
        </Column>
      </div>
    </div>
  );
}

function Column({
  title,
  count,
  action,
  className,
  children,
}: {
  title: string;
  count: number;
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        "flex min-w-0 shrink-0 flex-col border border-border bg-card/40",
        className,
      )}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="border border-border px-1.5 font-mono text-[11px] tabular-nums text-muted-foreground">
          {count}
        </span>
        <div className="ml-auto flex items-center">{action}</div>
      </div>
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">{children}</div>
    </section>
  );
}

const EMPTY_QUEUE: QueuedIssue[] = [];

// Everything the row needs about one agent's load, derived once per tick.
interface AgentPlan {
  open: Thread[];
  queued: QueuedIssue[];
  halting: Thread | null;
  concurrency: number;
  rate: number | null;
  history: ReturnType<typeof finishedRuns>;
  forecast: AgentForecast;
  runningMinutes: { startedAt: number; minutes: number }[];
  queuedMinutes: number[];
}

function agentPlan(
  project: Project,
  allThreads: Thread[],
  agent: string,
  now: number,
): AgentPlan {
  const history = finishedRuns(allThreads, agent);
  const open = openRuns(project.threads, agent);
  const queued = queueOf(project.fleet?.queue ?? [], agent);
  const concurrency = Math.max(1, project.fleet?.concurrency[agent] ?? 1);
  const runningMinutes = open.map((t) => ({
    startedAt: t.fleetRun!.startedAt,
    minutes: estimateMinutes(history, t.fleetRun!.estimate),
  }));
  const queuedMinutes = queued.map((q) => estimateMinutes(history, q.issue.estimate));
  return {
    open,
    queued,
    halting: haltingThread(project.threads, agent),
    concurrency,
    rate: costPerMinute(history),
    history,
    forecast: forecast(now, runningMinutes, queuedMinutes, concurrency),
    runningMinutes,
    queuedMinutes,
  };
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function IssueCard({
  issue,
  agents,
  onAssign,
  onDrag,
}: {
  issue: LinearIssue;
  agents: SubagentDef[];
  onAssign: (agent: string) => void;
  onDrag: (dragging: boolean) => void;
}) {
  const [dragging, setDragging] = useState(false);
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(ISSUE_MIME, issue.id);
        e.dataTransfer.effectAllowed = "move";
        setDragging(true);
        onDrag(true);
      }}
      onDragEnd={() => {
        setDragging(false);
        onDrag(false);
      }}
      data-issue-id={issue.id}
      className={cn(
        "group/issue cursor-grab border border-border bg-card active:cursor-grabbing",
        dragging && "opacity-40",
      )}
    >
      <div className="px-2.5 pt-2">
        <div className="flex items-center gap-1.5 text-[11px]">
          <span className="font-mono text-foreground/80">{issue.identifier}</span>
          <span
            className={cn(
              "ml-auto text-muted-foreground",
              issue.priority === 1 && "text-destructive",
              issue.priority === 2 && "text-amber-500",
            )}
          >
            {issue.priority === 0 ? null : issue.priorityLabel}
          </span>
        </div>
        <p className="mt-1 line-clamp-2 pb-2 text-sm leading-snug text-foreground">
          {issue.title}
        </p>
      </div>
      <div className="flex h-8 items-center gap-1 border-t border-border px-2.5 text-[11px] text-muted-foreground">
        <span className="min-w-0 truncate">
          {issue.labels.length > 0 ? issue.labels.join(" · ") : issue.stateName}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/issue:opacity-100 has-[[data-state=open]]:opacity-100">
          <button
            type="button"
            onClick={() => void openUrl(issue.url)}
            className="flex size-6 items-center justify-center hover:text-foreground"
            aria-label={`Open ${issue.identifier} in Linear`}
            title="Open in Linear"
          >
            <ExternalLink className="size-3.5" />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex h-6 items-center gap-0.5 px-1.5 hover:bg-accent hover:text-foreground"
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
        {issue.estimate !== null && (
          <span className="shrink-0 pl-1 font-mono">{issue.estimate} pt</span>
        )}
      </div>
    </div>
  );
}

const OUTCOME_LABEL: Record<string, string> = {
  error: "failed",
  stopped: "was stopped",
  interrupted: "was interrupted when Hoy closed",
};

function AgentRow({
  def,
  project,
  plan,
  dragged,
  now,
  onDropIssue,
}: {
  def: SubagentDef;
  project: Project;
  plan: AgentPlan;
  dragged: LinearIssue | null;
  now: number;
  onDropIssue: (issueId: string) => void;
}) {
  const streaming = useSessionStore((s) => s.streaming);
  const setAgentConcurrency = useSessionStore((s) => s.setAgentConcurrency);
  const resumeAgent = useSessionStore((s) => s.resumeAgent);
  const [over, setOver] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const { open, queued, halting, concurrency, rate, history } = plan;
  const busy = open.length >= concurrency;
  const rest = agentThreads(project.threads, def.name).filter(
    (t) => !open.includes(t) && t !== halting,
  );
  const live = rest.filter((t) => streaming[t.id]);
  const done = rest.filter((t) => !streaming[t.id]);

  const preview = useMemo(() => {
    if (!over || !dragged) return null;
    const minutes = estimateMinutes(history, dragged.estimate);
    const after = forecast(
      now,
      plan.runningMinutes,
      [...plan.queuedMinutes, minutes],
      concurrency,
    );
    return { minutes, until: after.busyUntil };
  }, [over, dragged, history, now, plan, concurrency]);

  const basis =
    history.length === 0
      ? "No finished runs yet"
      : `From ${history.length} finished run${history.length === 1 ? "" : "s"}`;
  const empty =
    open.length + queued.length + live.length + done.length === 0 && !halting;

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
        "px-3 py-3 outline outline-1 -outline-offset-1 outline-transparent transition-colors",
        over && "bg-brand/5 outline-brand",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Bot className="size-4 shrink-0 text-agent" />
        <span className="truncate text-sm font-semibold">{def.name}</span>
        <span
          className="shrink-0 font-mono text-xs text-muted-foreground"
          title={`Estimate. ${basis}.`}
        >
          {rate == null ? "$--" : formatCost(rate)}/min
        </span>
        {preview && (
          <span
            className="min-w-0 truncate font-mono text-xs text-brand"
            title={`Estimate. ${basis}.`}
          >
            {rate != null && `+${formatCost(preview.minutes * rate)} · `}+
            {formatMinutes(preview.minutes)}
            {preview.until != null && ` until ${formatClock(preview.until)}`}
          </span>
        )}
        <span
          className={cn(
            "ml-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs",
            halting
              ? "text-amber-500"
              : busy
                ? "text-muted-foreground"
                : "text-emerald-500",
          )}
          title={plan.forecast.busyUntil != null ? `Estimate. ${basis}.` : undefined}
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              halting
                ? "bg-amber-500"
                : busy
                  ? "bg-muted-foreground/60"
                  : "bg-emerald-500",
            )}
          />
          {halting
            ? "Halted"
            : busy && plan.forecast.busyUntil != null
              ? `Busy until ${formatClock(plan.forecast.busyUntil)}`
              : open.length > 0
                ? `${open.length}/${concurrency} running`
                : "Free"}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex h-6 shrink-0 items-center gap-1 px-1 text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent"
              aria-label={`${def.name} options`}
              title="Runs at once"
            >
              <span className="border border-border px-1 font-mono text-[11px]">
                x{concurrency}
              </span>
              <MoreHorizontal className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Runs at once</DropdownMenuLabel>
            {[1, 2, 3, 4].map((n) => (
              <DropdownMenuItem
                key={n}
                onSelect={() => setAgentConcurrency(project.id, def.name, n)}
              >
                {n === concurrency ? <Check className="size-4" /> : <span className="size-4" />}
                {n}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {def.description && (
        <p className="mt-0.5 truncate pl-6 text-xs text-muted-foreground">
          {def.description}
        </p>
      )}
      {halting && (
        <div className="mt-2 ml-6 flex min-w-0 items-center gap-2 border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-xs text-amber-500">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">
            {halting.linearIssue?.identifier ?? halting.title}{" "}
            {OUTCOME_LABEL[halting.fleetRun?.outcome ?? ""] ?? "did not finish"}
            {queued.length > 0 && `, ${queued.length} queued waiting`}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto h-6 shrink-0 border-amber-500/40 px-2 text-xs text-amber-500 hover:text-amber-400"
            onClick={() => resumeAgent(project.id, def.name)}
          >
            Resume queue
          </Button>
        </div>
      )}
      {empty && !preview ? (
        <p className="mt-2 pl-6 text-xs italic text-muted-foreground/70">No work yet</p>
      ) : (
        <div className="mt-2 ml-6 divide-y divide-border border border-border bg-background/40">
          {open.map((t, i) => (
            <ThreadTask
              key={t.id}
              thread={t}
              state={streaming[t.id] ? "running" : "starting"}
              meta={`~${formatMinutes(
                Math.max(
                  plan.runningMinutes[i].minutes - (now - t.fleetRun!.startedAt) / 60_000,
                  1,
                ),
              )} left`}
            />
          ))}
          {live.map((t) => (
            <ThreadTask key={t.id} thread={t} state="running" />
          ))}
          {halting && <ThreadTask thread={halting} state="failed" />}
          {queued.map((q, i) => (
            <QueuedTask
              key={q.issue.id}
              projectId={project.id}
              item={q}
              minutes={plan.queuedMinutes[i]}
              first={i === 0}
              last={i === queued.length - 1}
            />
          ))}
          {preview && dragged && (
            <TaskShell className="border border-dashed border-brand/60 bg-brand/5 text-brand">
              <Plus className="size-3.5 shrink-0" />
              <span className="shrink-0 whitespace-nowrap font-mono text-[11px]">
                {dragged.identifier}
              </span>
              <span className="min-w-0 truncate">Queue {dragged.title}</span>
              <span className="ml-auto shrink-0 font-mono text-[11px]">
                ~{formatMinutes(preview.minutes)}
              </span>
            </TaskShell>
          )}
          {done.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => setShowDone((v) => !v)}
                className="flex h-7 w-full items-center gap-1.5 px-2 text-left text-[11px] text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                aria-expanded={showDone}
              >
                <ChevronRight
                  className={cn("size-3.5 transition-transform", showDone && "rotate-90")}
                />
                {done.length} done
              </button>
              {showDone &&
                done.map((t) => <ThreadTask key={t.id} thread={t} state="finished" />)}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function TaskShell({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "group/task flex h-8 min-w-0 items-center gap-2 px-2 text-xs",
        className,
      )}
    >
      {children}
    </div>
  );
}

type TaskState = "running" | "starting" | "finished" | "failed";

// One row of an agent's stack: a delegated issue, or a subagent another
// thread spawned.
function ThreadTask({
  thread,
  state,
  meta,
}: {
  thread: Thread;
  state: TaskState;
  meta?: string;
}) {
  const openThread = useSessionStore((s) => s.openThread);
  const stopStreaming = useSessionStore((s) => s.stopStreaming);
  const archiveThread = useSessionStore((s) => s.archiveThread);
  const issue = thread.linearIssue;
  const live = state === "running" || state === "starting";
  const run = thread.fleetRun;
  const failed = state === "failed" || (run?.outcome != null && run.outcome !== "done");
  // Spawned subagents belong to their parent; only delegated work gets controls.
  const own = !!run || !!issue;
  const label = issue?.identifier ?? thread.title;
  const took =
    run?.endedAt != null ? formatMinutes((run.endedAt - run.startedAt) / 60_000) : null;
  return (
    <TaskShell
      className={cn(
        live && "bg-brand/10",
        state === "failed" && "text-amber-500",
        state === "finished" && "text-muted-foreground",
      )}
    >
      <button
        type="button"
        onClick={() => openThread(thread.id)}
        title={issue ? `${issue.identifier} ${issue.title}` : thread.title}
        className="flex h-full min-w-0 flex-1 items-center gap-2 text-left hover:text-foreground"
      >
        {live ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-brand" />
        ) : failed ? (
          <AlertTriangle className="size-3.5 shrink-0 text-amber-500" />
        ) : (
          <Check className="size-3.5 shrink-0" />
        )}
        {issue ? (
          <span className="shrink-0 whitespace-nowrap font-mono text-[11px]">
            {issue.identifier}
          </span>
        ) : (
          <Bot className="size-3.5 shrink-0 text-agent" />
        )}
        <span className="min-w-0 truncate">{issue ? issue.title : thread.title}</span>
      </button>
      {(meta ?? took) && (
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
          {meta ?? took}
        </span>
      )}
      {own && (
        <button
          type="button"
          onClick={() =>
            live ? void stopStreaming(thread.id) : archiveThread(thread.id)
          }
          disabled={state === "starting"}
          className={cn(
            "flex size-6 shrink-0 items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40",
            !live && "opacity-0 focus-visible:opacity-100 group-hover/task:opacity-100",
          )}
          aria-label={live ? `Stop ${label}` : `Archive ${label}`}
          title={live ? "Stop" : "Archive and release the issue"}
        >
          {live ? <Square className="size-3" /> : <Archive className="size-3.5" />}
        </button>
      )}
    </TaskShell>
  );
}

function QueuedTask({
  projectId,
  item,
  minutes,
  first,
  last,
}: {
  projectId: string;
  item: QueuedIssue;
  minutes: number;
  first: boolean;
  last: boolean;
}) {
  const moveQueuedIssue = useSessionStore((s) => s.moveQueuedIssue);
  const unqueueIssue = useSessionStore((s) => s.unqueueIssue);
  const { issue } = item;
  return (
    <TaskShell className="text-muted-foreground">
      <Clock className="size-3.5 shrink-0" />
      <span className="shrink-0 whitespace-nowrap font-mono text-[11px]">
        {issue.identifier}
      </span>
      <span className="min-w-0 flex-1 truncate" title={issue.title}>
        {issue.title}
      </span>
      <span className="shrink-0 font-mono text-[11px]">~{formatMinutes(minutes)}</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Queued ${issue.identifier}`}
            className="flex size-6 shrink-0 items-center justify-center hover:bg-accent hover:text-foreground data-[state=open]:bg-accent"
          >
            <MoreHorizontal className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            disabled={first}
            onSelect={() => moveQueuedIssue(projectId, issue.id, -1)}
          >
            <ArrowUp className="size-4" />
            Move up
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={last}
            onSelect={() => moveQueuedIssue(projectId, issue.id, 1)}
          >
            <ArrowDown className="size-4" />
            Move down
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void openUrl(issue.url)}>
            <ExternalLink className="size-4" />
            Open in Linear
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => unqueueIssue(projectId, issue.id)}>
            <X className="size-4" />
            Unassign
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </TaskShell>
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

// Placeholder for a board control that is not wired yet (Auto, HOY-353).
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
