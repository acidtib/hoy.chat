import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Archive,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  Clock,
  ExternalLink,
  GripVertical,
  GitPullRequest,
  Loader2,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { LinearIcon } from "@/components/icons/LinearIcon";
import { SourceForm } from "@/components/fleet/SourcePicker";
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
import { agentThreads, unassignedIssues } from "@/lib/delegate";
import { decisionCosts } from "@/lib/dispatch";
import { branchStatus, ghStatus, projectIsGitRepo, type GhStatus } from "@/lib/ipc";
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
  DispatchDecision,
  LinearIssue,
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
  if (!status) {
    return <Notice title="Checking Linear..." />;
  }
  // Until a source is linked, the Todo column holds the link form.
  const linked = project.linear && (status.workspaces ?? []).length > 0;
  return <Board project={project} teamId={linked ? project.linear!.teamId : null} />;
}

function Board({ project, teamId }: { project: Project; teamId: string | null }) {
  const cache = useLinearStore((s) => s.issues[project.id] ?? EMPTY_ISSUES);
  const refreshIssues = useLinearStore((s) => s.refreshIssues);
  const subagents = useSessionStore((s) => s.subagents);
  const refreshSubagents = useSessionStore((s) => s.refreshSubagents);
  const enqueueIssue = useSessionStore((s) => s.enqueueIssue);
  const triageAuto = useSessionStore((s) => s.triageAuto);
  const decideIssue = useSessionStore((s) => s.decideIssue);
  const projects = useSessionStore((s) => s.projects);
  const [dragged, setDragged] = useState<LinearIssue | null>(null);
  const now = useNow(30_000);
  const nonGit = useSessionStore((s) => !!s.nonGitProjects[project.id]);
  useEffect(() => {
    if (!project.path) return;
    let cancelled = false;
    void projectIsGitRepo(project.path)
      .then((isGit) => {
        if (cancelled) return;
        useSessionStore.setState((s) => {
          const nonGitProjects = { ...s.nonGitProjects };
          if (isGit) delete nonGitProjects[project.id];
          else nonGitProjects[project.id] = true;
          return { nonGitProjects };
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [project.id, project.path]);

  useEffect(() => {
    if (teamId && cache.fetchedAt === null && !cache.loading && !cache.error) {
      void refreshIssues(project.id, teamId, project.linear?.workspaceId);
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
    if (teamId && running < prevRunning.current) void refreshIssues(project.id, teamId, project.linear?.workspaceId);
    prevRunning.current = running;
  }, [running, project.id, teamId, refreshIssues]);
  const open = useMemo(
    () => unassignedIssues(cache.items, project.threads, queue),
    [cache.items, project.threads, queue],
  );

  // HOY-353: triageAuto is idempotent, so re-running on every change is cheap.
  const auto = !!project.fleet?.auto;
  useEffect(() => {
    if (!auto || !teamId) return;
    void triageAuto(project.id);
  }, [auto, teamId, cache.items, open.length, subagents.length, project.id, triageAuto]);

  const decisions = project.fleet?.decisions;
  const decisionTotal = decisionCosts(decisions) + (project.fleet?.dispatchSpend ?? 0);

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

  const decisionOf = (issue: LinearIssue): DispatchDecision | null => {
    const cached = decisions?.[issue.id];
    return cached && cached.at === (issue.updatedAt ?? null) ? cached.decision : null;
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-3 px-4 pt-3 text-xs text-muted-foreground">
        <GripVertical className="size-3.5 shrink-0 opacity-50" />
        <span className="truncate">
          {teamId ? "Drag a task onto an agent to queue it" : "Link a task source to fill the Todo column"}
        </span>
        {nonGit && (
          <span className="shrink-0 text-amber-500" title="Without git there are no worktrees, so agents would overwrite each other.">
            Not a git repository: tasks run one at a time in the project folder
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-3">
          <span
            className="font-mono"
            title={[
              decisionTotal > 0
                ? `${formatCost(decisionTotal)} spent on Dispatcher decisions.`
                : null,
              unpriced
                ? "Queue estimate. Agents with no finished runs yet are not counted."
                : "Queue estimate from each agent's finished runs.",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {decisionTotal > 0 && (
              <span className="text-muted-foreground">
                {formatCost(decisionTotal)} decisions ·{" "}
              </span>
            )}
            {total > 0 ? `~${formatCost(total)}${unpriced ? "+" : ""}` : unpriced ? "$--" : "$0"}{" "}
            in queues
          </span>
          <PullRequestToggle project={project} />
          <AutoToggle project={project} />
        </div>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 gap-3 p-4 pt-2">
        <Column
          title="Todo"
          count={teamId ? open.length : undefined}
          className="w-72"
          action={
            teamId && <Button
              variant="ghost"
              size="icon-sm"
              className="size-7 text-muted-foreground"
              onClick={() => void refreshIssues(project.id, teamId, project.linear?.workspaceId)}
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
            {!teamId ? (
              <div className="p-1">
                <SourceForm project={project} />
              </div>
            ) : cache.error ? (
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
                  decision={decisionOf(issue)}
                  onDecide={() => decideIssue(project.id, issue)}
                  onAssign={(agent) => assign(issue.id, agent)}
                  onDrag={(d) => setDragged(d ? issue : null)}
                />
              ))
            )}
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
  count?: number;
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
        {count !== undefined && (
          <span className="border border-border px-1.5 font-mono text-[11px] tabular-nums text-muted-foreground">
            {count}
          </span>
        )}
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
  decision,
  onDecide,
  onAssign,
  onDrag,
}: {
  issue: LinearIssue;
  agents: SubagentDef[];
  decision: DispatchDecision | null;
  onDecide: () => Promise<void>;
  onAssign: (agent: string) => void;
  onDrag: (dragging: boolean) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [deciding, setDeciding] = useState(false);
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
          <span title="From Linear" className="flex text-muted-foreground">
            <LinearIcon className="size-3" />
            <span className="sr-only">From Linear</span>
          </span>
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
        <p className="mt-1 pb-2 text-sm leading-snug break-words text-foreground">
          {issue.title}
        </p>
        {decision && (
          <div className="flex items-center gap-1.5 px-2.5 pb-2 text-[11px]">
            <Bot
              className={cn(
                "size-3 shrink-0",
                decision.ready && decision.agent
                  ? "text-agent"
                  : decision.ready
                    ? "text-muted-foreground"
                    : "text-amber-500",
              )}
            />
            <span className="shrink-0 font-medium">
              {decision.agent ?? (decision.ready ? "Held" : "Not ready")}
            </span>
            {decision.agent && (
              <span className="shrink-0 font-mono text-muted-foreground">
                {Math.round(decision.confidence * 100)}%
              </span>
            )}
            <span
              className="min-w-0 truncate text-muted-foreground"
              title={[decision.reason, decision.missing]
                .filter(Boolean)
                .join("\n")}
            >
              {decision.missing ?? decision.reason}
            </span>
          </div>
        )}
      </div>
      <div className="flex h-8 items-center gap-1 border-t border-border px-2.5 text-[11px] text-muted-foreground">
        <span className="min-w-0 truncate">
          {issue.labels.length > 0 ? issue.labels.join(" · ") : issue.stateName}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/issue:opacity-100 has-[[data-state=open]]:opacity-100">
          <button
            type="button"
            onClick={() => void openUrl(issue.url)}
            className="flex size-6 cursor-pointer items-center justify-center hover:text-foreground"
            aria-label={`Open ${issue.identifier} in Linear`}
            title="Open in Linear"
          >
            <ExternalLink className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => {
              setDeciding(true);
              void onDecide().finally(() => setDeciding(false));
            }}
            disabled={deciding}
            className="flex size-6 cursor-pointer items-center justify-center hover:text-foreground disabled:cursor-default disabled:opacity-40"
            aria-label={`Ask the Dispatcher about ${issue.identifier}`}
            title="Run the Dispatcher decision for this task. It never assigns."
          >
            {deciding ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Sparkles className="size-3.5" />
            )}
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex cursor-pointer h-6 items-center gap-0.5 px-1.5 hover:bg-accent hover:text-foreground"
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
  const startAgentThread = useSessionStore((s) => s.startAgentThread);
  const [over, setOver] = useState(false);
  const { open, queued, halting, concurrency, rate, history } = plan;
  const busy = open.length >= concurrency;
  const rest = agentThreads(project.threads, def.name).filter(
    (t) => !open.includes(t) && t !== halting,
  );
  const live = rest.filter((t) => streaming[t.id]);
  // Archiving could not take the worktree down; the run stays until resolved.
  const stuck = rest.filter((t) => !streaming[t.id] && t.worktreeIssue);
  // HOY-379: a chain waiting on the user, or a handoff offered with Auto off.
  const waiting = rest.filter(
    (t) => !streaming[t.id] && !t.worktreeIssue && (t.chainStop?.needsUser || t.nextStep),
  );
  // A run that opened a pull request waits on review, so it stays until archived.
  const inReview = rest.filter(
    (t) => !streaming[t.id] && !t.worktreeIssue && !waiting.includes(t) && t.pullRequest,
  );
  // The last run of an issue whose branch has work and no pull request: it
  // stays until the user opens one or archives it.
  const unshipped = rest.filter(
    (t) =>
      !streaming[t.id] &&
      !t.worktreeIssue &&
      !waiting.includes(t) &&
      !t.pullRequest &&
      !t.handedTo &&
      t.fleetRun?.outcome === "done" &&
      t.worktree &&
      !t.worktree.removed,
  );
  const branches = useBranchStatuses(unshipped);
  const ready = unshipped.filter((t) => {
    const b = branches[t.id];
    return !b || b.ahead > 0 || b.dirty;
  });
  const done = rest.filter((t) => {
    const at = finishedAt(t);
    return (
      !streaming[t.id] &&
      !t.worktreeIssue &&
      !waiting.includes(t) &&
      !ready.includes(t) &&
      !t.pullRequest &&
      at != null &&
      Date.now() - at < DONE_LINGER_MS
    );
  });
  // Re-render when the oldest finished row expires, so the stack drops it
  // without waiting for the board's slower clock.
  const [, expire] = useState(0);
  const nextExpiry = done.length
    ? Math.min(...done.map((t) => finishedAt(t)! + DONE_LINGER_MS))
    : null;
  useEffect(() => {
    if (nextExpiry == null) return;
    const id = setTimeout(() => expire((n) => n + 1), Math.max(0, nextExpiry - Date.now()));
    return () => clearTimeout(id);
  }, [nextExpiry]);

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
    open.length + queued.length + live.length + stuck.length + waiting.length + ready.length + inReview.length + done.length === 0 &&
    !halting;

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
        <Button
          variant="ghost"
          size="sm"
          className="h-6 shrink-0 gap-1 px-2 text-xs"
          onClick={() => startAgentThread(project.id, def.name)}
        >
          <Plus className="size-3" />
          New thread
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex cursor-pointer h-6 shrink-0 items-center gap-1 px-1 text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent"
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
          {stuck.map((t) => (
            <WorktreeTask key={t.id} thread={t} />
          ))}
          {waiting.map((t) => (
            <ChainTask key={t.id} thread={t} />
          ))}
          {ready.map((t) => (
            <ReadyTask key={t.id} thread={t} status={branches[t.id] ?? null} projectId={project.id} />
          ))}
          {inReview.map((t) => (
            <ThreadTask key={t.id} thread={t} state="finished" />
          ))}
          {done.map((t) => (
            <DoneTask key={t.id} thread={t} at={finishedAt(t)!} />
          ))}
        </div>
      )}
    </div>
  );
}

// Finished work stays in the stack this long, then fades out of it.
const DONE_LINGER_MS = 20_000;
const DONE_FADE_MS = 1_000;

// When a thread's work ended: its Fleet run, or a spawned subagent's delivery.
function finishedAt(t: Thread): number | null {
  return t.fleetRun?.endedAt ?? t.completedAt ?? null;
}

function DoneTask({ thread, at }: { thread: Thread; at: number }) {
  const [phase, setPhase] = useState<"shown" | "fading" | "gone">("shown");
  useEffect(() => {
    const left = at + DONE_LINGER_MS - Date.now();
    const fade = setTimeout(() => setPhase("fading"), Math.max(0, left - DONE_FADE_MS));
    const gone = setTimeout(() => setPhase("gone"), Math.max(0, left));
    return () => {
      clearTimeout(fade);
      clearTimeout(gone);
    };
  }, [at]);
  if (phase === "gone") return null;
  return (
    <div
      className={cn(
        "transition-opacity duration-1000 motion-reduce:transition-none",
        phase === "fading" && "opacity-0",
      )}
    >
      <ThreadTask thread={thread} state="finished" />
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
  const handOffThread = useSessionStore((s) => s.handOffThread);
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
        title={[
          issue ? `${issue.identifier} ${issue.title}` : thread.title,
          thread.worktree && `Branch ${thread.worktree.branch}`,
        ]
          .filter(Boolean)
          .join("\n")}
        className="flex h-full cursor-pointer min-w-0 flex-1 items-center gap-2 text-left hover:text-foreground"
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
        <HandoffChip thread={thread} />
      </button>
      {(meta ?? took) && (
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
          {meta ?? took}
        </span>
      )}
      {thread.pullRequest && (
        <button
          type="button"
          onClick={() => void openUrl(thread.pullRequest!)}
          className="flex size-6 shrink-0 cursor-pointer items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={`Open the pull request for ${label}`}
          title={thread.pullRequest}
        >
          <GitPullRequest className="size-3.5" />
        </button>
      )}
      {own && issue && thread.agent && !thread.handedTo && state !== "starting" && (
        <AgentMenu
          exclude={thread.agent}
          label={`Hand off ${label}`}
          title={live ? "Stop this run and hand the issue to another agent" : "Hand the issue to another agent"}
          heading="Hand off to"
          onPick={(agent) => void handOffThread(thread.id, agent)}
          className={cn(!live && "opacity-0 focus-visible:opacity-100 group-hover/task:opacity-100 data-[state=open]:opacity-100")}
        />
      )}
      {own && (
        <button
          type="button"
          onClick={() =>
            live ? void stopStreaming(thread.id) : archiveThread(thread.id)
          }
          disabled={state === "starting"}
          className={cn(
            "flex size-6 shrink-0 cursor-pointer items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-40",
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

function useEnabledAgents(exclude?: string | null): SubagentDef[] {
  const subagents = useSessionStore((s) => s.subagents);
  return useMemo(
    () => subagents.filter((d) => d.enabled && d.name !== exclude),
    [subagents, exclude],
  );
}

// HOY-379: where a run's issue came from and went.
function HandoffChip({ thread }: { thread: Thread }) {
  const { handoff, handedTo } = thread;
  if (!handoff && !handedTo) return null;
  return (
    <span
      className="ml-auto shrink-0 whitespace-nowrap text-[11px] text-muted-foreground"
      title={[handoff && `From ${handoff.fromAgent}: ${handoff.reason}`, handedTo && `Handed to ${handedTo}`]
        .filter(Boolean)
        .join("\n")}
    >
      {handoff && `from ${handoff.fromAgent}`}
      {handoff && handedTo && " "}
      {handedTo && (
        <>
          <ArrowRight className="inline size-3 align-[-2px]" /> {handedTo}
        </>
      )}
    </span>
  );
}

function AgentMenu({
  exclude,
  label,
  title,
  heading,
  onPick,
  className,
}: {
  exclude: string;
  label: string;
  title: string;
  heading: string;
  onPick: (agent: string) => void;
  className?: string;
}) {
  const agents = useEnabledAgents(exclude);
  if (agents.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={label}
          title={title}
          className={cn(
            "flex size-6 shrink-0 cursor-pointer items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent",
            className,
          )}
        >
          <ArrowRight className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{heading}</DropdownMenuLabel>
        {agents.map((a) => (
          <DropdownMenuItem key={a.name} onSelect={() => onPick(a.name)}>
            <Bot className="size-4 text-agent" />
            {a.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// HOY-379: a finished run whose chain waits on the user, or (Auto off) the
// handoff it suggests.
function ChainTask({ thread }: { thread: Thread }) {
  const openThread = useSessionStore((s) => s.openThread);
  const acceptNextStep = useSessionStore((s) => s.acceptNextStep);
  const dismissChainNote = useSessionStore((s) => s.dismissChainNote);
  const issue = thread.linearIssue;
  const next = thread.nextStep;
  const reason = next?.reason ?? thread.chainStop?.reason ?? "";
  return (
    <div className={cn("group/task px-2 py-1.5 text-xs", next ? "bg-brand/5" : "bg-amber-500/10")}>
      <div className="flex min-w-0 items-center gap-2">
        {next ? (
          <ArrowRight className="size-3.5 shrink-0 text-brand" />
        ) : (
          <AlertTriangle className="size-3.5 shrink-0 text-amber-500" />
        )}
        <button
          type="button"
          onClick={() => openThread(thread.id)}
          className="min-w-0 flex-1 cursor-pointer truncate text-left hover:text-foreground"
          title={reason}
        >
          {issue && <span className="mr-2 font-mono text-[11px]">{issue.identifier}</span>}
          {next ? `Next: ${next.agent}. ${reason}` : `Waiting for you: ${reason}`}
        </button>
        {next && (
          <Button
            variant="outline"
            size="sm"
            className="h-6 shrink-0 cursor-pointer px-2 text-xs"
            onClick={() => acceptNextStep(thread.id)}
          >
            Hand off to {next.agent}
          </Button>
        )}
        <button
          type="button"
          onClick={() => dismissChainNote(thread.id)}
          className="flex size-6 shrink-0 cursor-pointer items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={`Dismiss the note on ${issue?.identifier ?? thread.title}`}
          title="Dismiss"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

type BranchState = { ahead: number; dirty: boolean };

// What each finished run left on its branch, checked once per run.
function useBranchStatuses(threads: Thread[]): Record<string, BranchState> {
  const [statuses, setStatuses] = useState<Record<string, BranchState>>({});
  const key = threads.map((t) => t.id).join(",");
  useEffect(() => {
    let cancelled = false;
    for (const t of threads) {
      if (statuses[t.id] || !t.worktree) continue;
      void branchStatus(t.worktree.path, t.worktree.base)
        .then((s) => !cancelled && setStatuses((m) => ({ ...m, [t.id]: s })))
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [key]);
  return statuses;
}

// HOY-379: a finished issue's branch with work and no pull request yet.
function ReadyTask({
  thread,
  status,
  projectId,
}: {
  thread: Thread;
  status: BranchState | null;
  projectId: string;
}) {
  const openThread = useSessionStore((s) => s.openThread);
  const archiveThread = useSessionStore((s) => s.archiveThread);
  const openRunPullRequest = useSessionStore((s) => s.openRunPullRequest);
  const startAgentThread = useSessionStore((s) => s.startAgentThread);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wt = thread.worktree!;
  const issue = thread.linearIssue;
  const label = issue?.identifier ?? thread.title;
  const summary =
    status && status.ahead > 0
      ? `${status.ahead} commit${status.ahead === 1 ? "" : "s"} on ${wt.branch}`
      : `on ${wt.branch}`;
  return (
    <div className="group/task bg-emerald-500/5 px-2 py-1.5 text-xs">
      <div className="flex min-w-0 items-center gap-2">
        <Check className="size-3.5 shrink-0 text-emerald-500" />
        <button
          type="button"
          onClick={() => openThread(thread.id)}
          className="min-w-0 flex-1 cursor-pointer truncate text-left hover:text-foreground"
          title={[thread.chainStop?.reason, wt.path].filter(Boolean).join("\n")}
        >
          {issue && <span className="mr-2 font-mono text-[11px]">{issue.identifier}</span>}
          Ready: {summary}
          {status?.dirty && <span className="text-amber-500">, uncommitted changes</span>}
        </button>
        {(status?.ahead ?? 1) > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="h-6 shrink-0 cursor-pointer px-2 text-xs"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              void openRunPullRequest(thread.id)
                .catch((e) => setError(String(e)))
                .finally(() => setBusy(false));
            }}
            title={`Push ${wt.branch} and open a pull request against ${wt.base}`}
          >
            {busy ? <Loader2 className="size-3 animate-spin" /> : <GitPullRequest className="size-3" />}
            Open pull request
          </Button>
        )}
        {thread.agent && (
          <Button
            variant="outline"
            size="sm"
            className="h-6 shrink-0 cursor-pointer gap-1 px-2 text-xs"
            onClick={() =>
              startAgentThread(projectId, thread.agent!, { fromRunThreadId: thread.id })
            }
            title={`Talk to ${thread.agent} in ${wt.path}`}
          >
            <Bot className="size-3 text-agent" />
            Talk to {thread.agent}
          </Button>
        )}
        <button
          type="button"
          onClick={() => archiveThread(thread.id)}
          className="flex size-6 shrink-0 cursor-pointer items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={`Archive ${label}`}
          title="Archive and remove the worktree. The branch is kept."
        >
          <Archive className="size-3.5" />
        </button>
      </div>
      {error && <p className="truncate pl-5.5 text-amber-500" title={error}>{error}</p>}
    </div>
  );
}

// HOY-359: let this project's agents push their branch and open a pull request.
// Needs the GitHub CLI installed and signed in, checked when the board opens.
function PullRequestToggle({ project }: { project: Project }) {
  const setOpenPullRequests = useSessionStore((s) => s.setOpenPullRequests);
  const [gh, setGh] = useState<GhStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    void ghStatus().then((g) => !cancelled && setGh(g)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const on = !!project.fleet?.openPullRequests;
  const ready = !!gh && !gh.problem;
  return (
    <label
      className="flex cursor-pointer items-center gap-1.5 border-l border-border pl-3"
      title={
        gh?.problem ??
        "Agents push their issue branch and open a pull request with gh when they finish. Off: they commit on the branch only."
      }
    >
      Pull requests
      <Switch
        checked={on && ready}
        disabled={!ready && !on}
        onCheckedChange={(v) => setOpenPullRequests(project.id, v)}
        aria-label="Agents open pull requests"
      />
    </label>
  );
}

// HOY-358: a finished run whose worktree archiving could not remove.
function WorktreeTask({ thread }: { thread: Thread }) {
  const openThread = useSessionStore((s) => s.openThread);
  const archiveDelegated = useSessionStore((s) => s.archiveDelegated);
  const [busy, setBusy] = useState(false);
  const issue = thread.linearIssue;
  return (
    <div className="bg-amber-500/10 px-2 py-1.5 text-xs">
      <div className="flex min-w-0 items-center gap-2">
        <AlertTriangle className="size-3.5 shrink-0 text-amber-500" />
        <button
          type="button"
          onClick={() => openThread(thread.id)}
          className="min-w-0 flex-1 cursor-pointer truncate text-left hover:text-foreground"
        >
          {issue && <span className="mr-2 font-mono text-[11px]">{issue.identifier}</span>}
          {thread.worktreeIssue}
        </button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 shrink-0 cursor-pointer px-2 text-xs"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void archiveDelegated(thread.id, true).finally(() => setBusy(false));
          }}
          title="Discard the worktree's changes and archive. The branch is kept."
        >
          Remove anyway
        </Button>
      </div>
      {thread.worktree && (
        <p className="truncate pl-5.5 font-mono text-[11px] text-muted-foreground">{thread.worktree.path}</p>
      )}
    </div>
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
  const moveQueuedTo = useSessionStore((s) => s.moveQueuedTo);
  const unqueueIssue = useSessionStore((s) => s.unqueueIssue);
  const agents = useEnabledAgents(item.agent);
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
      {item.handoff && (
        <span className="shrink-0 whitespace-nowrap text-[11px]" title={item.handoff.reason}>
          from {item.handoff.fromAgent}
        </span>
      )}
      <span className="shrink-0 font-mono text-[11px]">~{formatMinutes(minutes)}</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Queued ${issue.identifier}`}
            className="flex cursor-pointer size-6 shrink-0 items-center justify-center hover:bg-accent hover:text-foreground data-[state=open]:bg-accent"
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
          {agents.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Move to</DropdownMenuLabel>
              {agents.map((a) => (
                <DropdownMenuItem key={a.name} onSelect={() => moveQueuedTo(projectId, issue.id, a.name)}>
                  <Bot className="size-4 text-agent" />
                  {a.name}
                </DropdownMenuItem>
              ))}
            </>
          )}
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
          {link.workspaceName && (
            <span className="text-muted-foreground">· {link.workspaceName}</span>
          )}
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

function AutoToggle({ project }: { project: Project }) {
  const setFleetAuto = useSessionStore((s) => s.setFleetAuto);
  const on = !!project.fleet?.auto;
  return (
    <label
      className="flex cursor-pointer items-center gap-1.5 border-l border-border pl-3"
      title="The Dispatcher decides which agent takes each unassigned task. Tasks it judges not ready stay in Todo with a note on the card."
    >
      Auto
      <Switch
        checked={on}
        onCheckedChange={(v) => setFleetAuto(project.id, v)}
        aria-label="Auto assign tasks"
      />
    </label>
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
