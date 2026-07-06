import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, FileText, Sparkle, TriangleAlert } from "lucide-react";
import { openPath } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { listSkills } from "@/lib/ipc";
import type { SkillDiagnostic, SkillInfo, SkillList } from "@/lib/types";
import { useSessionStore } from "@/state/store";
import { cn } from "@/lib/utils";
import { PanelHeader } from "./panels";

function SkillRow({ skill }: { skill: SkillInfo }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <Sparkle className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{skill.name}</span>
          {skill.disableModelInvocation && (
            <span
              className="shrink-0 border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground"
              title="The model won't invoke this on its own; run it with /skill:name"
            >
              manual only
            </span>
          )}
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {skill.description || "(no description)"}
        </p>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
        title="Open SKILL.md"
        aria-label="Open skill file"
        onClick={() => void openPath(skill.filePath)}
      >
        <FileText className="size-4" />
      </Button>
    </div>
  );
}

function DiagnosticRow({ diag }: { diag: SkillDiagnostic }) {
  const isError = diag.type === "error" || diag.type === "collision";
  const Icon = isError ? AlertCircle : TriangleAlert;
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 px-4 py-3 text-xs",
        isError
          ? "text-destructive"
          : "text-amber-600 dark:text-amber-400",
      )}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="leading-relaxed">{diag.message}</p>
        {diag.path && (
          <p className="truncate font-mono text-[11px] opacity-70">
            {diag.path}
          </p>
        )}
      </div>
    </div>
  );
}

function SkillList_({ children }: { children: React.ReactNode }) {
  return (
    <div className="divide-y divide-border border border-border">
      {children}
    </div>
  );
}

export function SkillsPanel() {
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const projects = useSessionStore((s) => s.projects);

  const projectPath = useMemo(
    () => projects.find((p) => p.id === activeProjectId)?.path ?? null,
    [projects, activeProjectId],
  );

  const [list, setList] = useState<SkillList | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      setList(await listSkills(projectPath ?? ""));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [projectPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const global = list?.skills.filter((s) => s.scope === "user") ?? [];
  const project = list?.skills.filter((s) => s.scope === "project") ?? [];
  const diagnostics = list?.diagnostics ?? [];

  return (
    <div className="space-y-8">
      <PanelHeader
        title="Skills"
        description="Skills are reusable instructions the agent can pull in on demand: a SKILL.md with a name and a description of when to use it. Drop one in a skills directory and the agent can invoke it, or run it yourself by typing /name in the composer."
      />

      {error && <p className="text-sm text-destructive">{error}</p>}

      {diagnostics.length > 0 && (
        <div className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold">Problems</h2>
            <p className="text-xs text-muted-foreground">
              Validation issues found while loading skills. Fix these so the
              agent uses the skill reliably.
            </p>
          </div>
          <SkillList_>
            {diagnostics.map((d, i) => (
              <DiagnosticRow key={i} diag={d} />
            ))}
          </SkillList_>
        </div>
      )}

      <div className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold">Global</h2>
          <p className="text-xs text-muted-foreground">
            Available in every project. Stored in the Hoy agent directory
            (~/.hoy/skills).
          </p>
        </div>
        {global.length > 0 ? (
          <SkillList_>
            {global.map((s) => (
              <SkillRow key={s.filePath} skill={s} />
            ))}
          </SkillList_>
        ) : (
          list && (
            <p className="text-xs text-muted-foreground">
              No global skills yet. Add a <code>SKILL.md</code> under{" "}
              <code>~/.hoy/skills/&lt;name&gt;/</code> and reopen this panel.
            </p>
          )
        )}
      </div>

      <div className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold">This project</h2>
          <p className="text-xs text-muted-foreground">
            {projectPath
              ? "Only for the active project. Stored in its .hoy/skills."
              : "Open a project to see skills scoped to it."}
          </p>
        </div>
        {projectPath &&
          (project.length > 0 ? (
            <SkillList_>
              {project.map((s) => (
                <SkillRow key={s.filePath} skill={s} />
              ))}
            </SkillList_>
          ) : (
            list && (
              <p className="text-xs text-muted-foreground">
                No project skills. Add a <code>SKILL.md</code> under{" "}
                <code>.hoy/skills/&lt;name&gt;/</code> in this project.
              </p>
            )
          ))}
      </div>

      {!list && !error && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Sparkle className="size-4" />
          Loading skills...
        </p>
      )}
    </div>
  );
}
