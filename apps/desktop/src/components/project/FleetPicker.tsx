import { useEffect, useMemo, useState } from "react";
import { useLinearStore } from "@/state/linear";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  CORE_AGENTS,
  FLEET_PRESETS,
  OPTIONAL_AGENTS,
  matchingPreset,
} from "@/lib/fleetPresets";
import type { SubagentDef } from "@/lib/types";
import { SourceForm } from "@/components/fleet/SourcePicker";
import { useSessionStore } from "@/state/store";

const MONOGRAM: Record<string, string> = {
  Researcher: "R",
  Architect: "A",
  Coder: "C",
  Tester: "T",
  Reviewer: "Rv",
  Writer: "W",
  "Project Manager": "PM",
  "Security Reviewer": "SR",
  DevOps: "DO",
  Frontend: "FE",
};

function toolHint(def?: SubagentDef): string | null {
  if (!def) return null;
  const has = (t: string) => def.tools.includes(t);
  if (has("edit") || has("write")) return has("bash") ? "edits code, runs commands" : "writes files";
  return has("bash") ? "read-only, runs checks" : "read-only";
}

function Monogram({ name, on, small }: { name: string; on: boolean; small?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center border font-mono font-semibold",
        small ? "size-5 text-[9px]" : "size-8 text-[11px]",
        on ? "border-brand/40 bg-brand/15 text-brand" : "border-border bg-muted/40 text-muted-foreground",
      )}
    >
      {MONOGRAM[name] ?? name.slice(0, 2)}
    </span>
  );
}

// HOY-368: asked once when a project without a saved fleet is added, and
// reopened from the project's Agents tab to change it. The
// choice is written to the project's .hoy/settings.json (hoy.agents).
export function FleetPicker() {
  const projectId = useSessionStore((s) => s.fleetPickerProjectId);
  const project = useSessionStore((s) => s.projects.find((p) => p.id === projectId) ?? null);
  const defs = useSessionStore((s) => s.subagents);
  const setFleetPicker = useSessionStore((s) => s.setFleetPicker);
  const saveFleet = useSessionStore((s) => s.saveFleet);

  const [selected, setSelected] = useState<Set<string>>(() => new Set(CORE_AGENTS));
  // HOY-372: a new project moves on to the Linear step after its fleet.
  const [linearFor, setLinearFor] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const initial = useSessionStore((s) => s.fleetPickerInitial);

  useEffect(() => {
    if (projectId) {
      setSelected(new Set(initial ?? CORE_AGENTS));
      setError(null);
    }
  }, [projectId, initial]);

  const preset = useMemo(() => matchingPreset(selected), [selected]);
  const defOf = (name: string) => defs.find((d) => d.name === name);

  const toggle = (name: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const isNew = !initial;
  const finishFleet = () => {
    if (isNew && projectId) setLinearFor(projectId);
    setFleetPicker(null);
  };

  const save = async () => {
    if (!projectId) return;
    setSaving(true);
    setError(null);
    try {
      if (isNew) setLinearFor(projectId);
      await saveFleet(projectId, [...selected]);
    } catch (e) {
      setLinearFor(null);
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const card = (name: string) => {
    const on = selected.has(name);
    const def = defOf(name);
    const hint = toolHint(def);
    return (
      <div
        key={name}
        role="button"
        tabIndex={0}
        aria-pressed={on}
        onClick={() => toggle(name)}
        onKeyDown={(e) => {
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            toggle(name);
          }
        }}
        className={cn(
          "flex cursor-pointer items-start gap-3 border p-3 transition-colors outline-none focus-visible:ring-1 focus-visible:ring-brand",
          on ? "border-foreground/20 bg-card" : "border-border bg-card/30 hover:bg-card/60",
        )}
      >
        <Monogram name={name} on={on} />
        <div className={cn("min-w-0 flex-1", !on && "opacity-60")}>
          <p className="text-sm font-medium">{name}</p>
          {def?.description && (
            <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-muted-foreground">{def.description}</p>
          )}
          {hint && <p className="mt-1.5 font-mono text-[10px] text-muted-foreground/80">{hint}</p>}
        </div>
        <Switch
          checked={on}
          onClick={(e) => e.stopPropagation()}
          onCheckedChange={() => toggle(name)}
          aria-label={`Include ${name}`}
        />
      </div>
    );
  };

  if (!project && linearFor) {
    return <LinearStep projectId={linearFor} onDone={() => setLinearFor(null)} />;
  }

  return (
    <Dialog open={!!project} onOpenChange={(open) => !open && finishFleet()}>
      <DialogContent className="flex max-h-[88vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[880px]">
        <div className="shrink-0 px-6 pt-6 pb-5">
          <DialogTitle className="text-lg">{initial ? "Change your fleet" : "Choose your fleet"}</DialogTitle>
          <DialogDescription className="mt-1">
            Pick the agents Hoy can hand work to in this project. Saved with the repo in .hoy, and you can change it any time in Settings.
          </DialogDescription>
        </div>

        <div className="scrollbar-thin min-h-0 flex-1 space-y-6 overflow-y-auto px-6 pb-6">
          <div className="grid grid-cols-4 gap-2" role="radiogroup" aria-label="Preset">
            {FLEET_PRESETS.map((p) => {
              const active = preset === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setSelected(new Set(p.agents))}
                  className={cn(
                    "flex cursor-pointer flex-col items-start border p-3 text-left transition-colors",
                    active ? "border-brand bg-brand/10" : "border-border bg-card/30 hover:bg-card/60",
                  )}
                >
                  <p className="text-sm font-medium">{p.label}</p>
                  <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{p.description}</p>
                  <div className="mt-3 flex flex-wrap gap-1">
                    {p.agents.length ? (
                      p.agents.map((a) => <Monogram key={a} name={a} on={active} small />)
                    ) : (
                      <span aria-hidden className="size-5 border border-dashed border-muted-foreground/50" />
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          <section>
            <h3 className="pb-2 text-xs font-medium text-muted-foreground">Core</h3>
            <div className="grid grid-cols-2 gap-2">{CORE_AGENTS.map(card)}</div>
          </section>
          <section>
            <h3 className="pb-2 text-xs font-medium text-muted-foreground">Optional</h3>
            <div className="grid grid-cols-2 gap-2">{OPTIONAL_AGENTS.map(card)}</div>
          </section>
        </div>

        <div className="flex shrink-0 items-center gap-3 border-t border-border px-6 py-3">
          <p className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
            {error ? (
              <span className="text-destructive">{error}</span>
            ) : (
              `${selected.size} ${selected.size === 1 ? "agent" : "agents"} · custom agents in .hoy/agents are always available`
            )}
          </p>
          <Button variant="ghost" className="cursor-pointer" onClick={finishFleet}>
            {initial ? "Cancel" : "Skip"}
          </Button>
          <Button className="cursor-pointer" disabled={saving} onClick={() => void save()}>
            Save fleet
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Step two for a new project: pick a task source and link a team, landing on
// the Fleet; skipping lands on the project's new thread.
function LinearStep({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const project = useSessionStore((s) => s.projects.find((p) => p.id === projectId) ?? null);
  const openProject = useSessionStore((s) => s.openProject);
  const openThread = useSessionStore((s) => s.openThread);
  const addThread = useSessionStore((s) => s.addThread);
  const status = useLinearStore((s) => s.status);
  const refreshStatus = useLinearStore((s) => s.refreshStatus);
  const cancelOAuth = useLinearStore((s) => s.cancelOAuth);

  useEffect(() => {
    if (!status) void refreshStatus();
  }, [status, refreshStatus]);

  const skip = () => {
    void cancelOAuth();
    // The project's starter thread, or a fresh one when it has none.
    const starter = project?.threads.find((t) => t.title === "New thread" && !t.sessionFile);
    if (starter) openThread(starter.id);
    else addThread(projectId);
    onDone();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && skip()}>
      <DialogContent className="flex max-h-[88vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-md">
        <div className="px-6 pt-6 pb-4">
          <DialogTitle className="text-base">Connect a task source</DialogTitle>
          <DialogDescription className="mt-1">
            Open issues from the team you link show up in {project?.name}&apos;s Fleet, ready to hand to an agent.
          </DialogDescription>
        </div>
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          {project && (
            <SourceForm
              project={project}
              onLinked={() => {
                openProject(projectId, "fleet");
                onDone();
              }}
            />
          )}
        </div>
        <div className="flex items-center justify-end border-t border-border px-6 py-3">
          <Button variant="ghost" className="cursor-pointer" onClick={skip}>
            Skip for now
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
