import { useLayoutEffect, useRef, useState } from "react";
import {
  AtSign,
  ChevronDown,
  Maximize2,
  Plus,
  SendHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ModelSelect } from "@/components/ModelSelect";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { ModelInfo } from "@/lib/types";

const MODES = ["Agent", "Plan Mode"];
const THINKING = ["Minimal", "Low", "Medium", "High"];

// Zed-style agent composer. `fill` makes it expand to fill the panel (the empty
// thread state); otherwise it auto-grows from one line up to a cap and docks at
// the bottom of an active thread. CSS field-sizing isn't supported in the Tauri
// WebKit webview, so the textarea is grown in JS.
export function Composer({
  value,
  onChange,
  onSubmit,
  models,
  currentModel,
  selecting,
  onSelectModel,
  fill = false,
  placeholder = "Message  ·  @ to include context, / for commands",
  autoFocus = false,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  models: ModelInfo[];
  currentModel?: ModelInfo | null;
  selecting: boolean;
  onSelectModel: (provider: string, modelId: string) => void;
  fill?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [mode, setMode] = useState(MODES[0]);
  const [thinking, setThinking] = useState("High");

  useLayoutEffect(() => {
    if (fill) return;
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value, fill]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!disabled && value.trim()) onSubmit?.();
    }
  }

  const canSend = !disabled && value.trim().length > 0;

  return (
    <div className={cn("relative flex min-h-0 flex-col", fill && "h-full")}>
      {!fill && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="absolute right-1.5 top-1.5 size-7 text-muted-foreground"
          aria-label="Expand"
        >
          <Maximize2 className="size-3.5" />
        </Button>
      )}

      <textarea
        ref={textareaRef}
        rows={fill ? undefined : 1}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        autoFocus={autoFocus}
        disabled={disabled}
        placeholder={disabled ? "Streaming response..." : placeholder}
        className={cn(
          "scrollbar-thin w-full resize-none bg-transparent pl-4 pt-3.5 text-sm leading-6 text-foreground placeholder:text-muted-foreground/70 focus:outline-none",
          fill
            ? "min-h-0 flex-1 overflow-y-auto pr-4"
            : "max-h-[240px] min-h-[80px] overflow-y-auto pr-10",
        )}
      />

      <div className="flex items-center justify-between gap-2 px-2 py-1.5">
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            aria-label="Add context"
          >
            <Plus className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            aria-label="Mention context"
          >
            <AtSign className="size-4" />
          </Button>
        </div>

        <div className="flex items-center gap-0.5">
          <PillSelect value={mode} options={MODES} onSelect={setMode} />
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
          <PillSelect
            value={thinking}
            options={THINKING}
            onSelect={setThinking}
          />
          <Button
            variant="outline"
            size="icon-sm"
            className={cn(
              "ml-1 rounded-md",
              canSend
                ? "border-brand/40 text-brand hover:text-brand"
                : "text-muted-foreground",
            )}
            disabled={!canSend}
            onClick={() => canSend && onSubmit?.()}
            aria-label="Send"
          >
            <SendHorizontal className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function PillSelect({
  value,
  options,
  onSelect,
}: {
  value: string;
  options: string[];
  onSelect: (value: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none"
        >
          {value}
          <ChevronDown className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-32">
        {options.map((option) => (
          <DropdownMenuItem key={option} onSelect={() => onSelect(option)}>
            {option}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
