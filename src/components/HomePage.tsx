import { useMemo, useState } from "react";
import {
  CornerDownLeft,
  Folder,
  GitBranch,
  Monitor,
  Plus,
  Settings,
  Sparkle,
  SquareDashed,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ModelSelect } from "@/components/ModelSelect";
import { useSessionStore } from "@/state/store";
import type { ModelInfo } from "@/lib/types";

export function HomePage({
  onOpenSettings,
  models,
  currentModel,
  selecting,
  onSelectModel,
}: {
  onOpenSettings: () => void;
  models: ModelInfo[];
  currentModel?: ModelInfo | null;
  selecting: boolean;
  onSelectModel: (provider: string, modelId: string) => void;
}) {
  const projects = useSessionStore((s) => s.projects);
  const [draft, setDraft] = useState("");

  // Most recently active project labels the composer's project chip.
  const projectName = useMemo(() => {
    if (projects.length === 0) return null;
    const recency = (p: (typeof projects)[number]) =>
      p.threads.reduce((max, t) => Math.max(max, t.updatedAt), 0);
    return [...projects].sort((a, b) => recency(b) - recency(a))[0].name;
  }, [projects]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-background">
      <Button
        variant="ghost"
        size="icon-sm"
        className="absolute right-3 top-3 text-muted-foreground"
        onClick={onOpenSettings}
        aria-label="Settings"
      >
        <Settings className="size-4" />
      </Button>

      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-10">
        <div className="flex items-center gap-2 pt-10">
          <Sparkle className="size-5 text-brand" />
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            What&rsquo;s up next?
          </h1>
        </div>

        <div className="flex-1" />

        <div className="pb-3">
          <div className="flex items-center gap-1.5 pb-2">
            <Chip icon={Monitor} label="Local" />
            <Chip icon={Folder} label={projectName ?? "No project"} />
            <Chip icon={GitBranch} label="main" />
            <span className="mx-0.5 h-4 w-px bg-border" aria-hidden />
            <Chip icon={SquareDashed} label="worktree" />
          </div>

          <div className="relative rounded-2xl border border-border bg-card/60 shadow-sm transition-colors focus-within:border-ring/60">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={1}
              placeholder="Describe a task or ask a question"
              className="block max-h-48 w-full resize-none bg-transparent px-4 py-3.5 pr-12 text-sm leading-relaxed text-foreground placeholder:text-muted-foreground focus:outline-none"
            />
            <Button
              size="icon-sm"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg"
              disabled={!draft.trim()}
              aria-label="Send"
            >
              <CornerDownLeft className="size-4" />
            </Button>
          </div>

          <div className="flex items-center justify-between pt-2">
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              aria-label="Add context"
            >
              <Plus className="size-4" />
            </Button>
            <ModelSelect
              models={models}
              current={
                currentModel
                  ? { provider: currentModel.provider, id: currentModel.id }
                  : null
              }
              disabled={selecting}
              onSelect={onSelectModel}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function Chip({
  icon: Icon,
  label,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card/40 px-2 py-1 text-xs text-muted-foreground">
      <Icon className="size-3.5" />
      <span className="max-w-[10rem] truncate">{label}</span>
    </span>
  );
}
