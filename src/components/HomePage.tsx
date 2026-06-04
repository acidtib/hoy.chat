import { useMemo, useState } from "react";
import { Settings, Sparkle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Composer } from "@/components/Composer";
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

        <div className="pb-2">
          <Composer
            value={draft}
            onChange={setDraft}
            models={models}
            currentModel={currentModel}
            selecting={selecting}
            onSelectModel={onSelectModel}
            projectName={projectName}
            autoFocus
          />
        </div>
      </div>
    </div>
  );
}
