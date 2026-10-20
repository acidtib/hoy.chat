import { useEffect, useMemo, useState } from "react";
import { Bot, Loader2, Plus, Search, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProjectFleet, TeamMenu } from "@/components/fleet/ProjectFleet";
import { ThreadModelIcon } from "@/components/ThreadModelIcon";
import type { ModelInfo, Project, SubagentDef, Thread } from "@/lib/types";
import { Switch } from "@/components/ui/switch";
import { AgentModelSelect } from "@/components/AgentModelSelect";
import { visibleModels } from "@/lib/models";
import { usePrefsStore } from "@/state/prefs";
import { agentThreads } from "@/lib/delegate";
import { cn, formatRelativeTime } from "@/lib/utils";
import { isSubagentThread } from "@/state/delivery";
import { useLinearStore } from "@/state/linear";
import { type ProjectView, useSessionStore } from "@/state/store";

const VIEWS: { id: ProjectView; label: string }[] = [
  { id: "fleet", label: "Fleet" },
  { id: "threads", label: "Threads" },
  { id: "agents", label: "Agents" },
];

// HOY-346: a project's home, the main entry once a project is selected.
export function ProjectHome() {
  const projects = useSessionStore((s) => s.projects);
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const view = useSessionStore((s) => s.projectView);
  const openProject = useSessionStore((s) => s.openProject);
  const status = useLinearStore((s) => s.status);

  const project =
    projects.find((p) => p.id === activeProjectId) ?? projects[0] ?? null;
  if (!project) return null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <header className="flex h-12 shrink-0 items-center gap-4 border-b border-border px-3">
        <nav className="flex h-full items-stretch" aria-label="Project views">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => openProject(project.id, v.id)}
              aria-current={view === v.id ? "page" : undefined}
              className={cn(
                "cursor-pointer border-b-2 px-3 text-sm transition-colors",
                view === v.id
                  ? "border-brand text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {v.label}
            </button>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          {project.linear && status?.connected && !status.error && (
            <TeamMenu project={project} />
          )}
        </div>
      </header>
      {view === "fleet" ? (
        <ProjectFleet project={project} />
      ) : view === "threads" ? (
        <ThreadsView project={project} />
      ) : (
        <AgentsView project={project} />
      )}
    </div>
  );
}

// Top-level threads; spawned subagent children are reached through their parent.
export function projectThreads(project: Project): Thread[] {
  return project.threads
    .filter((t) => !t.archived && !isSubagentThread(t))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function ThreadsView({ project }: { project: Project }) {
  const addThread = useSessionStore((s) => s.addThread);
  const openThread = useSessionStore((s) => s.openThread);
  const streaming = useSessionStore((s) => s.streaming);
  const [query, setQuery] = useState("");

  const threads = useMemo(() => {
    const all = projectThreads(project);
    const q = query.trim().toLowerCase();
    return q ? all.filter((t) => t.title.toLowerCase().includes(q)) : all;
  }, [project, query]);

  return (
    <div className="flex min-h-0 flex-1 flex-col p-4">
      <div className="flex shrink-0 items-center gap-2 pb-3">
        <div className="relative w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search threads..."
            className="h-8 w-full border border-border bg-transparent pl-8 pr-2 text-sm placeholder:text-muted-foreground focus:border-ring focus:outline-none"
          />
        </div>
        <Button size="sm" className="ml-auto" onClick={() => addThread(project.id)}>
          <Plus className="size-4" />
          New thread
        </Button>
      </div>
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto border border-border bg-card/40">
        {threads.length === 0 ? (
          <p className="p-4 text-xs text-muted-foreground">
            {query ? "No matching threads." : "No threads yet."}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {threads.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => openThread(t.id)}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-accent/50"
                >
                  {streaming[t.id] ? (
                    <Loader2 className="size-3.5 shrink-0 animate-spin text-brand" />
                  ) : (
                    <ThreadModelIcon
                      model={t.model}
                      className="size-3.5 shrink-0 text-muted-foreground"
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm">{t.title}</span>
                  {t.agent && (
                    <span className="flex shrink-0 items-center gap-1 text-xs text-agent">
                      <Bot className="size-3.5" />
                      {t.agent}
                    </span>
                  )}
                  <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                    {formatRelativeTime(t.updatedAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// HOY-368: the project's fleet. On/off and each agent's model are saved to the
// project's .hoy/settings.json; the definitions live in Settings, Agents.
function AgentsView({ project }: { project: Project }) {
  const subagents = useSessionStore((s) => s.subagents);
  const refreshSubagents = useSessionStore((s) => s.refreshSubagents);
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);
  const setFleetPicker = useSessionStore((s) => s.setFleetPicker);
  const setAgentEnabled = useSessionStore((s) => s.setProjectAgentEnabled);
  const setAgentModel = useSessionStore((s) => s.setProjectAgentModel);
  const models = useSessionStore((s) => s.models);
  const disabledModels = usePrefsStore((p) => p.disabledModels);
  const pickable = useMemo(() => visibleModels(models, disabledModels), [models, disabledModels]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refreshSubagents(project.path ?? "");
  }, [project.path, refreshSubagents]);

  const run = (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    fn()
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  };

  const builtin = subagents.filter((d) => d.scope === "builtin");
  const custom = subagents.filter((d) => d.scope !== "builtin");
  const onCount = subagents.filter((d) => d.enabled).length;
  const group = (title: string, defs: SubagentDef[]) =>
    defs.length > 0 && (
      <section key={title}>
        <h3 className="pb-1.5 text-xs font-medium text-muted-foreground">{title}</h3>
        <ul className="divide-y divide-border border border-border bg-card/40">
          {defs.map((def) => (
            <AgentItem
              key={def.name}
              def={def}
              project={project}
              models={pickable}
              busy={busy}
              onToggle={(on) => run(() => setAgentEnabled(project.id, def.name, on))}
              onModel={(m) => run(() => setAgentModel(project.id, def.name, m))}
            />
          ))}
        </ul>
      </section>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col p-4">
      <div className="flex shrink-0 items-center gap-2 pb-3">
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          {subagents.length > 0
            ? `${onCount} of ${subagents.length} agents on in this project. Saved in .hoy/settings.json.`
            : "The agents tasks can be handed to in this project."}
        </p>
        <Button
          variant="outline"
          size="sm"
          className="cursor-pointer"
          onClick={() =>
            setFleetPicker(
              project.id,
              builtin.filter((d) => d.enabled).map((d) => d.name),
            )
          }
        >
          Choose preset
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="cursor-pointer"
          onClick={() => setSettingsOpen(true, "subagents")}
        >
          <Settings2 className="size-4" />
          Agent library
        </Button>
      </div>
      {error && <p className="pb-2 text-xs text-destructive">{error}</p>}
      <div className="scrollbar-thin min-h-0 flex-1 space-y-4 overflow-y-auto">
        {subagents.length === 0 ? (
          <p className="p-4 text-xs text-muted-foreground">Loading agents...</p>
        ) : (
          <>
            {group("Built-in", builtin)}
            {group("Your agents", custom)}
          </>
        )}
      </div>
    </div>
  );
}

function AgentItem({
  def,
  project,
  models,
  busy,
  onToggle,
  onModel,
}: {
  def: SubagentDef;
  project: Project;
  models: ModelInfo[];
  busy: boolean;
  onToggle: (on: boolean) => void;
  onModel: (model: string | null) => void;
}) {
  const streaming = useSessionStore((s) => s.streaming);
  const threads = agentThreads(project.threads, def.name);
  const working = threads.filter((t) => streaming[t.id]).length;
  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <div
        className={cn(
          "flex size-7 shrink-0 items-center justify-center border border-border bg-background text-agent",
          !def.enabled && "opacity-50",
        )}
      >
        <Bot className="size-4" />
      </div>
      <div className={cn("min-w-0 flex-1", !def.enabled && "opacity-50")}>
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold">{def.name}</span>
          {def.enabled && (working > 0 || threads.length > 0) && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {working > 0 ? `${working} working` : `${threads.length} ${threads.length === 1 ? "task" : "tasks"}`}
            </span>
          )}
        </div>
        {def.description && <p className="truncate text-xs text-muted-foreground">{def.description}</p>}
      </div>
      <AgentModelSelect value={def.model ?? null} models={models} disabled={busy || !def.enabled} onChange={onModel} />
      <Switch
        checked={def.enabled}
        disabled={busy}
        onCheckedChange={onToggle}
        aria-label={`Use ${def.name} in this project`}
      />
    </li>
  );
}
