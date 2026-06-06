import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  AtSign,
  ChevronDown,
  Maximize2,
  Minimize2,
  Plus,
  SendHorizontal,
  Square,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ModelSelect } from "@/components/ModelSelect";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ModelInfo, ModelRef, PermissionMode } from "@/lib/types";

// Thread permission modes (HOY-186), in selector order. Labels are display
// only; the wire values are the PermissionMode union.
const MODE_LABELS: Array<{ value: PermissionMode; label: string }> = [
  { value: "default", label: "Default" },
  { value: "acceptEdits", label: "Accept Edits" },
  { value: "plan", label: "Plan" },
  { value: "autonomous", label: "Autonomous" },
];
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
  mode = "default",
  onSelectMode,
  onStop,
  fill = false,
  placeholder = "Message  ·  @ to include context, / for commands",
  autoFocus = false,
  disabled = false,
  expanded = false,
  onToggleExpand,
  focusSignal = 0,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  models: ModelInfo[];
  currentModel?: ModelRef | null;
  selecting: boolean;
  onSelectModel: (provider: string, modelId: string) => void;
  mode?: PermissionMode;
  onSelectMode?: (mode: PermissionMode) => void;
  // While streaming, the send button becomes Stop (HOY-195). `disabled` keeps
  // gating the textarea and sending; onStop is the abort.
  onStop?: () => void;
  fill?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  onToggleExpand?: () => void;
  focusSignal?: number;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [thinking, setThinking] = useState("High");

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    // In fill mode the textarea is sized by flex; a stale inline height from
    // docked mode would fight it.
    if (fill) {
      el.style.height = "";
      return;
    }
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value, fill]);

  // Click-driven focus: a non-zero signal focuses, including on mount (the
  // fresh-open path mounts with its own brand-new request). Re-renders with an
  // unchanged signal never re-fire. Remounts cannot replay a stale request;
  // the store clears it on closePanel/toggleFullScreen. preventScroll: the
  // focus must not fight ThreadView's smooth scrollIntoView, which owns
  // bringing the panel into view (the race leaves the strip parked short).
  useEffect(() => {
    if (focusSignal) textareaRef.current?.focus({ preventScroll: true });
  }, [focusSignal]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!disabled && value.trim()) onSubmit?.();
    }
  }

  const canSend = !disabled && value.trim().length > 0;

  return (
    <div className={cn("relative flex min-h-0 flex-col", fill && "h-full")}>
      {onToggleExpand && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute right-1.5 top-1.5 size-7 text-muted-foreground"
              onClick={onToggleExpand}
              aria-label={
                expanded ? "Minimize Message Editor" : "Expand Message Editor"
              }
            >
              {expanded ? (
                <Minimize2 className="size-3.5" />
              ) : (
                <Maximize2 className="size-3.5" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {expanded ? "Minimize Message Editor" : "Expand Message Editor"}
          </TooltipContent>
        </Tooltip>
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
            ? cn(
                "min-h-0 flex-1 overflow-y-auto",
                onToggleExpand ? "pr-10" : "pr-4",
              )
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
          <PillSelect
            value={
              MODE_LABELS.find((m) => m.value === mode)?.label ?? "Default"
            }
            options={MODE_LABELS.map((m) => m.label)}
            onSelect={(label) => {
              const picked = MODE_LABELS.find((m) => m.label === label);
              if (picked) onSelectMode?.(picked.value);
            }}
          />
          <ModelSelect
            models={models}
            current={currentModel ?? null}
            disabled={selecting}
            onSelect={onSelectModel}
          />
          <PillSelect
            value={thinking}
            options={THINKING}
            onSelect={setThinking}
          />
          {disabled && onStop ? (
            <Button
              variant="outline"
              size="icon-sm"
              className="ml-1 rounded-md border-destructive/40 text-destructive hover:text-destructive"
              onClick={onStop}
              aria-label="Stop"
            >
              <Square className="size-4" />
            </Button>
          ) : (
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
          )}
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
