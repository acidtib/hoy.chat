import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

// HOY-254: the create / edit / duplicate form for a custom subagent type. Pure UI
// over a local draft: it never imports the write IPC or SubagentDef, so it is
// decoupled from the persistence layer. The panel converts a saved draft into the
// write_subagent payload (adding scope + project) and calls the sidecar.

// The user-selectable tools, mirroring the sidecar's KNOWN_TOOLS. `agent` is never
// offered: subagents cannot spawn their own children (the depth cap), and the
// sidecar strips it regardless.
export const SUBAGENT_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "edit",
  "write",
  "mcp",
] as const;

// A sensible default allowlist for a fresh agent: the full working set minus mcp
// (which most custom agents will not need). The user edits from here.
const DEFAULT_TOOLS: string[] = ["read", "grep", "find", "ls", "bash", "edit", "write"];

// Built-in names a custom file must never take: precedence is builtin < global <
// project, so a same-named file would silently shadow the built-in. Lower-cased.
export const BUILTIN_SUBAGENT_NAMES = ["general-purpose", "explore", "plan"];

// The form is never a blank box: a fresh agent (and duplicating general-purpose,
// which has no static body) seeds this annotated example. UI-only scaffold; it is
// written verbatim into the .md on save like any other body, never a schema field.
export const EXAMPLE_STARTER_PROMPT = `You are a specialized subagent spawned to handle one focused task.

## Role
Describe what this agent is for in one or two sentences. Keep it narrow: a
subagent does one job well rather than everything.

## When to use
Spell out the situations where the parent agent should reach for this type, so
it delegates the right work here and nothing else.

## How to work
- State the approach: what to read first, what order to do things in.
- Note any tools to prefer or avoid.
- Keep going until the task is genuinely done, not just plausibly done.

## Output
Describe exactly what to return. The final message is the result the parent
receives, so make it the answer, not a status update.`;

export interface SubagentDraft {
  name: string;
  description: string;
  tools: string[];
  promptMode: "replace" | "append";
  model: string;
  thinking: string;
  inheritContext: boolean;
  // Kept as text so an empty field is "unset"; validated as a positive int.
  maxTurns: string;
  body: string;
}

export function emptyDraft(): SubagentDraft {
  return {
    name: "",
    description: "",
    tools: [...DEFAULT_TOOLS],
    promptMode: "replace",
    model: "",
    thinking: "",
    inheritContext: false,
    maxTurns: "",
    body: EXAMPLE_STARTER_PROMPT,
  };
}

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

// Field-keyed validation errors; an empty object means the draft is saveable.
export function validateDraft(
  draft: SubagentDraft,
  opts: { takenNames: Set<string> },
): Partial<Record<keyof SubagentDraft, string>> {
  const errors: Partial<Record<keyof SubagentDraft, string>> = {};
  // The name is the filename, so validate the raw input as a lowercase slug (an
  // uppercase entry is rejected, not silently normalized). Builtin/uniqueness
  // checks compare lower-cased so a collision is caught regardless of case.
  const raw = draft.name.trim();
  const name = raw.toLowerCase();
  if (!raw) {
    errors.name = "A name is required.";
  } else if (!SLUG.test(raw)) {
    errors.name = "Use a lowercase slug: letters, digits, and dashes.";
  } else if (BUILTIN_SUBAGENT_NAMES.includes(name)) {
    errors.name = "That name is reserved by a built-in agent.";
  } else if (opts.takenNames.has(name)) {
    errors.name = "An agent with this name already exists in this scope.";
  }
  if (!draft.body.trim()) {
    errors.body = "A system prompt is required.";
  }
  const turns = draft.maxTurns.trim();
  if (turns && !/^[1-9][0-9]*$/.test(turns)) {
    errors.maxTurns = "Max turns must be a positive whole number.";
  }
  return errors;
}

function Segmented({
  value,
  onChange,
}: {
  value: "replace" | "append";
  onChange: (v: "replace" | "append") => void;
}) {
  return (
    <div role="radiogroup" aria-label="Prompt mode" className="flex border border-border">
      {(["replace", "append"] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          role="radio"
          aria-checked={value === mode}
          onClick={() => onChange(mode)}
          className={cn(
            "flex-1 cursor-pointer border-r border-border px-2 py-1 text-center text-xs capitalize transition-colors last:border-r-0 hover:bg-accent",
            value === mode
              ? "bg-brand/15 text-brand hover:bg-brand/15"
              : "text-muted-foreground",
          )}
        >
          {mode}
        </button>
      ))}
    </div>
  );
}

export function SubagentEditor({
  open,
  mode,
  scopeLabel,
  initial,
  takenNames,
  modelOptions,
  busy,
  onCancel,
  onSave,
}: {
  open: boolean;
  mode: "new" | "edit";
  // "Global" or "This project" -- shown so the user knows where it will be written.
  scopeLabel: string;
  initial: SubagentDraft;
  // Lower-cased names already used in the target scope (excluding the one being
  // edited), for the uniqueness check.
  takenNames: Set<string>;
  // Model ids to suggest for the (still free-text) model field, from the live
  // model list. Free text is kept so an id the app hasn't loaded still works.
  modelOptions?: string[];
  busy: boolean;
  onCancel: () => void;
  onSave: (draft: SubagentDraft) => void;
}) {
  const [draft, setDraft] = useState<SubagentDraft>(initial);
  const [showErrors, setShowErrors] = useState(false);
  const errors = useMemo(() => validateDraft(draft, { takenNames }), [draft, takenNames]);
  const patch = (p: Partial<SubagentDraft>) => setDraft((d) => ({ ...d, ...p }));

  const toggleTool = (tool: string) =>
    patch({
      tools: draft.tools.includes(tool)
        ? draft.tools.filter((t) => t !== tool)
        : [...draft.tools, tool],
    });

  const submit = () => {
    if (Object.keys(errors).length > 0) {
      setShowErrors(true);
      return;
    }
    onSave(draft);
  };

  const err = (field: keyof SubagentDraft) =>
    showErrors && errors[field] ? (
      <p className="text-[11px] text-destructive">{errors[field]}</p>
    ) : null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{mode === "edit" ? `Edit ${initial.name}` : "New agent"}</DialogTitle>
          <DialogDescription>
            Written to {scopeLabel} as a .hoy/agents/*.md file the model can spawn.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="sa-name">Name</Label>
            <Input
              id="sa-name"
              value={draft.name}
              // The name is the filename; renaming an existing agent is out of scope.
              disabled={mode === "edit"}
              placeholder="code-reviewer"
              onChange={(e) => patch({ name: e.target.value })}
            />
            {err("name")}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sa-desc">Description</Label>
            <Input
              id="sa-desc"
              value={draft.description}
              placeholder="What this agent is for (shown in the spawn list)."
              onChange={(e) => patch({ description: e.target.value })}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Tools</Label>
            <div className="flex flex-wrap gap-1.5">
              {SUBAGENT_TOOLS.map((tool) => {
                const on = draft.tools.includes(tool);
                return (
                  <button
                    key={tool}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleTool(tool)}
                    className={cn(
                      "cursor-pointer border px-2 py-0.5 font-mono text-xs transition-colors",
                      on
                        ? "border-brand/45 bg-brand/15 text-brand"
                        : "border-border text-muted-foreground hover:bg-accent",
                    )}
                  >
                    {tool}
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] text-muted-foreground">
              The tools this agent may use. None selected falls back to the default set.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sa-body">System prompt</Label>
            <Textarea
              id="sa-body"
              value={draft.body}
              rows={10}
              className="font-mono text-xs"
              onChange={(e) => patch({ body: e.target.value })}
            />
            {err("body")}
          </div>

          <div className="space-y-1.5">
            <Label>Prompt mode</Label>
            <Segmented value={draft.promptMode} onChange={(v) => patch({ promptMode: v })} />
            <p className="text-[11px] text-muted-foreground">
              Replace swaps in this prompt; append adds it after Hoy's base prompt.
            </p>
          </div>

          <Collapsible>
            <CollapsibleTrigger className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
              Advanced
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-3 space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <Label htmlFor="sa-inherit">Inherit context</Label>
                  <p className="text-[11px] text-muted-foreground">
                    Fork the parent's transcript at spawn instead of a fresh start.
                  </p>
                </div>
                <Switch
                  id="sa-inherit"
                  checked={draft.inheritContext}
                  onCheckedChange={(v) => patch({ inheritContext: v })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sa-model">Model</Label>
                <Input
                  id="sa-model"
                  value={draft.model}
                  list={modelOptions?.length ? "sa-model-options" : undefined}
                  placeholder="Optional. Defaults to the parent thread's model."
                  onChange={(e) => patch({ model: e.target.value })}
                />
                {modelOptions?.length ? (
                  <datalist id="sa-model-options">
                    {modelOptions.map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                ) : null}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="sa-turns">Max turns</Label>
                  <Input
                    id="sa-turns"
                    value={draft.maxTurns}
                    inputMode="numeric"
                    placeholder="Unlimited"
                    onChange={(e) => patch({ maxTurns: e.target.value })}
                  />
                  {err("maxTurns")}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="sa-thinking">Thinking</Label>
                  <Input
                    id="sa-thinking"
                    value={draft.thinking}
                    placeholder="e.g. high"
                    onChange={(e) => patch({ thinking: e.target.value })}
                  />
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? "Saving..." : mode === "edit" ? "Save changes" : "Create agent"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
