import { useCallback, useEffect, useMemo, useState } from "react";
import { Copy, FileText, Pencil, Plus, Trash2 } from "lucide-react";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { deleteSubagent, listSubagents, writeSubagent } from "@/lib/ipc";
import type { SubagentDef, SubagentScope, SubagentWrite } from "@/lib/types";
import { useSessionStore } from "@/state/store";
import { PanelHeader, StatusDot } from "./panels";
import {
  emptyDraft,
  EXAMPLE_STARTER_PROMPT,
  SubagentEditor,
  type SubagentDraft,
} from "./SubagentEditor";

// A writable (non-builtin) target scope for authoring.
type WriteScope = Exclude<SubagentScope, "builtin">;

// A `<name>-copy` slug seed for the Duplicate action: lowercase the source name
// (built-ins like "Explore" have capitals) and strip anything not slug-safe.
function slugCopy(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${base || "agent"}-copy`;
}

function draftFromDef(def: SubagentDef): SubagentDraft {
  return {
    name: def.name,
    description: def.description ?? "",
    tools: def.tools ?? [],
    promptMode: def.promptMode,
    model: def.model ?? "",
    thinking: def.thinking ?? "",
    inheritContext: def.inheritContext ?? false,
    maxTurns: def.maxTurns != null ? String(def.maxTurns) : "",
    // A built-in with no static body (general-purpose) seeds the example starter
    // rather than a blank prompt.
    body: def.body ?? EXAMPLE_STARTER_PROMPT,
  };
}

function draftToWrite(draft: SubagentDraft): SubagentWrite {
  const turns = draft.maxTurns.trim();
  return {
    name: draft.name.trim(),
    description: draft.description.trim() || null,
    tools: draft.tools,
    promptMode: draft.promptMode,
    model: draft.model.trim() || null,
    thinking: draft.thinking.trim() || null,
    inheritContext: draft.inheritContext,
    maxTurns: turns ? Number(turns) : null,
    body: draft.body,
  };
}

// What the editor is currently working on. `originalName` is set in edit mode so
// the save path can delete the old file before the create-only write.
interface EditorState {
  mode: "new" | "edit";
  scope: WriteScope;
  draft: SubagentDraft;
  originalName?: string;
}

function AgentRow({
  def,
  onToggle,
  onEdit,
  onDuplicate,
  onDelete,
  busy,
}: {
  def: SubagentDef;
  onToggle?: (next: boolean) => void;
  onEdit?: () => void;
  onDuplicate: () => void;
  onDelete?: () => void;
  busy?: boolean;
}) {
  const isBuiltin = def.scope === "builtin";
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
      <div className="flex items-center gap-0.5">
        <Button variant="ghost" size="icon" title="Duplicate as a new agent" onClick={onDuplicate}>
          <Copy className="size-4" />
        </Button>
        {!isBuiltin && (
          <Button variant="ghost" size="icon" title="Edit" onClick={onEdit}>
            <Pencil className="size-4" />
          </Button>
        )}
        {def.source && (
          <Button variant="ghost" size="icon" title="Open definition file" onClick={() => void openPath(def.source!)}>
            <FileText className="size-4" />
          </Button>
        )}
        {!isBuiltin && (
          <Button
            variant="ghost"
            size="icon"
            title="Delete"
            className="text-muted-foreground hover:text-destructive"
            onClick={onDelete}
          >
            <Trash2 className="size-4" />
          </Button>
        )}
      </div>
      {isBuiltin ? (
        <span className="self-center text-xs text-muted-foreground">built-in</span>
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
  const refreshSubagents = useSessionStore((s) => s.refreshSubagents);
  const models = useSessionStore((s) => s.models);
  const modelOptions = useMemo(() => models.map((m) => m.id), [models]);
  const projectPath = useMemo(() => projects.find((p) => p.id === activeProjectId)?.path ?? null, [projects, activeProjectId]);

  // Serve the store cache (warmed by a prior open) immediately so reopening the
  // tab paints instantly, then revalidate in the background (HOY-274).
  const cached = useSessionStore((s) => s.subagents);
  const [defs, setDefs] = useState<SubagentDef[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<SubagentDef | null>(null);

  // The list to render: the fresh local copy once fetched, else the store cache,
  // else null (never loaded -> show the loading state).
  const shown = defs ?? (cached.length ? cached : null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const list = await listSubagents(projectPath ?? "");
      setDefs(list);
      // Warm the store cache from this same fetch -- no second list_subagents
      // call (HOY-274) -- so spawnChildThread can resolve project-scoped agents
      // as soon as this panel has been opened (HOY-234).
      useSessionStore.setState({ subagents: list });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [projectPath]);
  useEffect(() => { void refresh(); }, [refresh]);

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

  const byScope = (scope: SubagentScope) => (shown ?? []).filter((d) => d.scope === scope);

  // Names already used in a target scope (lower-cased), for the editor's
  // uniqueness check. In edit mode the agent's own name is excluded.
  const takenNames = (scope: WriteScope, exclude?: string) =>
    new Set(
      byScope(scope)
        .map((d) => d.name.toLowerCase())
        .filter((n) => n !== exclude?.toLowerCase()),
    );

  const openNew = (scope: WriteScope) =>
    setEditor({ mode: "new", scope, draft: emptyDraft() });

  const openEdit = (def: SubagentDef) => {
    if (def.scope === "builtin") return;
    setEditor({ mode: "edit", scope: def.scope, draft: draftFromDef(def), originalName: def.name });
  };

  const openDuplicate = (def: SubagentDef) => {
    // A built-in duplicate lands in the global scope; a scoped agent copies within
    // its own scope. The name defaults to a fresh -copy slug (still validated).
    const scope: WriteScope = def.scope === "builtin" ? "global" : def.scope;
    setEditor({ mode: "new", scope, draft: { ...draftFromDef(def), name: slugCopy(def.name) } });
  };

  const save = (draft: SubagentDraft) => {
    if (!editor) return;
    const { scope, mode, originalName } = editor;
    const proj = scope === "project" ? projectPath : null;
    setBusy(true);
    void (async () => {
      try {
        // Editing keeps the same filename, but write_subagent is create-only:
        // delete the old file first, then write the new content.
        if (mode === "edit" && originalName) {
          await deleteSubagent(scope, originalName, proj);
        }
        await writeSubagent(draftToWrite(draft), scope, proj);
        setEditor(null);
        await refresh();
        if (projectPath) await refreshSubagents(projectPath);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    })();
  };

  const remove = (def: SubagentDef) => {
    if (def.scope === "builtin") return;
    const scope = def.scope as WriteScope;
    const proj = scope === "project" ? projectPath : null;
    setBusy(true);
    void (async () => {
      try {
        await deleteSubagent(scope, def.name, proj);
        setConfirmDelete(null);
        await refresh();
        if (projectPath) await refreshSubagents(projectPath);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    })();
  };

  const scopeHeading = (scope: SubagentScope) =>
    scope === "builtin" ? "Built-in" : scope === "global" ? "Global" : "This project";

  return (
    <div className="space-y-6">
      <PanelHeader title="Subagents" description="Specialized agent types the model can spawn. Author them here or as .hoy/agents/*.md; built-ins are always available." />
      {error && <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>}
      {shown === null && !error && <p className="text-xs text-muted-foreground">Loading agents...</p>}
      {shown !== null && (["builtin", "global", "project"] as SubagentScope[]).map((scope) => {
        const rows = byScope(scope);
        if (scope === "project" && !projectPath) return null;
        const writable = scope !== "builtin";
        return (
          <div key={scope} className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">{scopeHeading(scope)}</h2>
              {writable && (
                <Button variant="outline" size="sm" onClick={() => openNew(scope as WriteScope)} disabled={busy}>
                  <Plus className="size-3.5" />
                  New agent
                </Button>
              )}
            </div>
            <div className="divide-y divide-border border border-border">
              {rows.length ? (
                rows.map((d) => (
                  <AgentRow
                    key={d.name}
                    def={d}
                    busy={busy}
                    onToggle={(v) => toggle(d, v)}
                    onEdit={() => openEdit(d)}
                    onDuplicate={() => openDuplicate(d)}
                    onDelete={() => setConfirmDelete(d)}
                  />
                ))
              ) : writable ? (
                <button
                  type="button"
                  onClick={() => openNew(scope as WriteScope)}
                  className="flex w-full cursor-pointer items-center gap-2 px-3 py-3 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <Plus className="size-3.5" />
                  No agents in this scope. New agent
                </button>
              ) : (
                <p className="px-3 py-2 text-xs text-muted-foreground">No agents in this scope.</p>
              )}
            </div>
          </div>
        );
      })}

      {editor && (
        <SubagentEditor
          open
          mode={editor.mode}
          scopeLabel={scopeHeading(editor.scope)}
          initial={editor.draft}
          takenNames={takenNames(editor.scope, editor.originalName)}
          modelOptions={modelOptions}
          busy={busy}
          onCancel={() => setEditor(null)}
          onSave={save}
        />
      )}

      <AlertDialog open={confirmDelete !== null} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {confirmDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the agent's .md file. Running sessions reload the registry; this cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={(e) => {
                // Keep the dialog controlled: run the delete, don't let the action
                // auto-close before it resolves.
                e.preventDefault();
                if (confirmDelete) remove(confirmDelete);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
