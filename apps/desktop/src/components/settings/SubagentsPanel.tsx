import { useCallback, useEffect, useMemo, useState } from "react";
import { FileText } from "lucide-react";
import { openPath } from "@tauri-apps/plugin-opener";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { listSubagents } from "@/lib/ipc";
import type { SubagentDef, SubagentScope } from "@/lib/types";
import { useSessionStore } from "@/state/store";
import { PanelHeader, StatusDot } from "./panels";

function AgentRow({ def, onToggle, busy }: { def: SubagentDef; onToggle?: (next: boolean) => void; busy?: boolean }) {
  return (
    <div className="flex items-start gap-3 px-3 py-2">
      <StatusDot on={def.enabled} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{def.name}</span>
          <Badge variant="outline" className="text-[10px]">{def.scope}</Badge>
          {def.model && <Badge variant="outline" className="text-[10px]">{def.model}</Badge>}
          {def.inheritContext && <Badge variant="outline" className="text-[10px]">inherits context</Badge>}
          {def.maxTurns ? <Badge variant="outline" className="text-[10px]">max {def.maxTurns} turns</Badge> : null}
        </div>
        {def.description && <p className="text-xs text-muted-foreground">{def.description}</p>}
        <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{def.tools.join(", ")}</p>
      </div>
      {def.source && (
        <Button variant="ghost" size="icon" title="Open definition file" onClick={() => void openPath(def.source!)}>
          <FileText className="size-4" />
        </Button>
      )}
      {def.scope === "builtin" ? (
        <span className="text-xs text-muted-foreground">built-in</span>
      ) : (
        <Switch checked={def.enabled} disabled={busy} onCheckedChange={(v) => onToggle?.(v)} aria-label={`Enable ${def.name}`} />
      )}
    </div>
  );
}

export function SubagentsPanel() {
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const projects = useSessionStore((s) => s.projects);
  const setSubagentEnabled = useSessionStore((s) => s.setSubagentEnabled);
  const projectPath = useMemo(() => projects.find((p) => p.id === activeProjectId)?.path ?? null, [projects, activeProjectId]);

  const [defs, setDefs] = useState<SubagentDef[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      setDefs(await listSubagents(projectPath ?? ""));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [projectPath]);
  useEffect(() => { void refresh(); }, [refresh]);

  // Warm the store cache so spawnChildThread can resolve project-scoped agents
  // as soon as this panel has been opened (HOY-234). Scoped to the project, not
  // folded into refresh(), so a per-row toggle does not re-fire it (HOY-243).
  useEffect(() => {
    void useSessionStore.getState().refreshSubagents(projectPath ?? "");
  }, [projectPath]);

  const toggle = (def: SubagentDef, next: boolean) => {
    setBusy(true);
    void (async () => {
      try {
        await setSubagentEnabled(def.scope, def.name, next, projectPath);
        await refresh();
      } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
      finally { setBusy(false); }
    })();
  };

  const byScope = (scope: SubagentScope) => (defs ?? []).filter((d) => d.scope === scope);

  return (
    <div className="space-y-6">
      <PanelHeader title="Subagents" description="Specialized agent types the model can spawn. Author them as .hoy/agents/*.md; built-ins are always available." />
      {error && <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>}
      {(["builtin", "global", "project"] as SubagentScope[]).map((scope) => {
        const rows = byScope(scope);
        if (scope === "project" && !projectPath) return null;
        return (
          <div key={scope} className="space-y-3">
            <h2 className="text-sm font-semibold capitalize">{scope === "builtin" ? "Built-in" : scope === "global" ? "Global" : "This project"}</h2>
            <div className="divide-y divide-border border border-border">
              {rows.length ? rows.map((d) => <AgentRow key={d.name} def={d} busy={busy} onToggle={(v) => toggle(d, v)} />)
                : <p className="px-3 py-2 text-xs text-muted-foreground">No agents in this scope.</p>}
            </div>
          </div>
        );
      })}
      {!defs && !error && <p className="text-xs text-muted-foreground">Loading agents...</p>}
    </div>
  );
}
