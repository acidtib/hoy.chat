import { useLayoutEffect, useRef } from "react";
import {
  CornerDownLeft,
  Folder,
  GitBranch,
  Monitor,
  Plus,
  SquareDashed,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ModelSelect } from "@/components/ModelSelect";
import type { ModelInfo } from "@/lib/types";

// Shared composer used by both the home page (new task) and an open thread.
// CSS field-sizing isn't supported in the Tauri WebKit webview, so the textarea
// is grown to fit its content in JS.
export function Composer({
  value,
  onChange,
  onSubmit,
  models,
  currentModel,
  selecting,
  onSelectModel,
  projectName,
  showContext = true,
  placeholder = "Describe a task or ask a question",
  autoFocus = false,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  models: ModelInfo[];
  currentModel?: ModelInfo | null;
  selecting: boolean;
  onSelectModel: (provider: string, modelId: string) => void;
  projectName?: string | null;
  showContext?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (value.trim()) onSubmit?.();
    }
  }

  return (
    <div>
      {showContext && (
        <div className="flex items-center gap-1.5 pb-2">
          <Chip icon={Monitor} label="Local" />
          <Chip icon={Folder} label={projectName ?? "No project"} />
          <Chip icon={GitBranch} label="main" />
          <span className="mx-0.5 h-4 w-px bg-border" aria-hidden />
          <Chip icon={SquareDashed} label="worktree" />
        </div>
      )}

      <div className="relative rounded-xl border border-border bg-card/50 shadow-sm transition-colors focus-within:border-ring/60">
        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          autoFocus={autoFocus}
          placeholder={placeholder}
          className="scrollbar-thin block w-full resize-none overflow-y-auto bg-transparent py-3 pl-4 pr-12 text-sm leading-6 text-foreground placeholder:text-muted-foreground focus:outline-none"
        />
        <Button
          variant="secondary"
          size="icon-sm"
          className="absolute bottom-2 right-2 rounded-lg"
          disabled={!value.trim()}
          onClick={() => value.trim() && onSubmit?.()}
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
