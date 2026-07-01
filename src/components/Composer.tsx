import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  AtSign,
  ChevronDown,
  File as FileIcon,
  Folder,
  Image as ImageIcon,
  Maximize2,
  MessageSquare,
  Minimize2,
  Plus,
  SendHorizontal,
  Square,
  X,
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
import { detectMention } from "@/lib/mention";
import { getCaretCoordinates } from "@/lib/caret";
import type {
  ContextRef,
  ExtWidget,
  ImageAttachment,
  ModelInfo,
  ModelRef,
  PathEntry,
  PermissionMode,
  ThinkingLevel,
} from "@/lib/types";
import { contextKey, THINKING_LEVELS } from "@/lib/types";

// The composer thread reference for the @ picker's Threads section (HOY-220).
interface ContextThread {
  threadId: string;
  title: string;
}

// Thinking levels (HOY-204). Labels are display only; pi's lowercase
// ThinkingLevel union is the wire value.
const THINKING_LABELS: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-High",
};

// Thread permission modes (HOY-186), in selector order. Labels are display
// only; the wire values are the PermissionMode union.
const MODE_LABELS: Array<{ value: PermissionMode; label: string }> = [
  { value: "default", label: "Default" },
  { value: "acceptEdits", label: "Accept Edits" },
  { value: "plan", label: "Plan" },
  { value: "autonomous", label: "Autonomous" },
];

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
  thinking,
  onSelectThinking,
  onStop,
  streaming = false,
  fill = false,
  placeholder = "Message  ·  @ to include context, / for commands",
  autoFocus = false,
  disabled = false,
  expanded = false,
  onToggleExpand,
  focusSignal = 0,
  widgets = [],
  attachments = [],
  onAddFiles,
  onRemoveAttachment,
  canAttachImages = true,
  contexts = [],
  onAddContext,
  onRemoveContext,
  searchPaths,
  threads = [],
}: {
  value: string;
  onChange: (value: string) => void;
  // "enter" is a normal send / steer; "shiftEnter" queues a follow-up mid-turn
  // (HOY-218). When idle, both start a normal turn.
  onSubmit?: (intent: "enter" | "shiftEnter") => void;
  models: ModelInfo[];
  currentModel?: ModelRef | null;
  selecting: boolean;
  onSelectModel: (provider: string, modelId: string) => void;
  mode?: PermissionMode;
  onSelectMode?: (mode: PermissionMode) => void;
  thinking: ThinkingLevel;
  onSelectThinking: (level: ThinkingLevel) => void;
  // While streaming, the Stop button appears alongside Send (HOY-195/HOY-218);
  // onStop is the abort. The composer stays enabled during a turn so the user
  // can steer (Enter) or queue a follow-up (Shift+Enter).
  onStop?: () => void;
  streaming?: boolean;
  fill?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  onToggleExpand?: () => void;
  focusSignal?: number;
  // Extension setWidget panels, rendered above or below the editor (ext UI).
  widgets?: ExtWidget[];
  // Image attachments (HOY-205): pending thumbnails + add/remove. Gated by the
  // active model's vision capability.
  attachments?: ImageAttachment[];
  onAddFiles?: (files: File[]) => void;
  onRemoveAttachment?: (id: string) => void;
  canAttachImages?: boolean;
  // @ context picker (HOY-220): current pills, add/remove, the gitignore-aware
  // path search, and the thread list for the Threads section.
  contexts?: ContextRef[];
  onAddContext?: (ref: ContextRef) => void;
  onRemoveContext?: (key: string) => void;
  searchPaths?: (query: string) => Promise<PathEntry[]>;
  threads?: ContextThread[];
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  // Active @-mention (HOY-220): the picker is open while this is set. `at` is the
  // `@` index in the value; `query` is the text typed after it (the filter).
  const [picker, setPicker] = useState<{ at: number; query: string } | null>(
    null,
  );
  const [pathResults, setPathResults] = useState<PathEntry[]>([]);
  // Fixed-viewport position for the picker menu, anchored at the @ caret
  // (HOY-220). `bottom` opens the menu above the caret line, `top` below when
  // there is not enough room above (the composer sits near the screen bottom).
  const [menuPos, setMenuPos] = useState<{
    left: number;
    top?: number;
    bottom?: number;
  } | null>(null);
  const aboveWidgets = widgets.filter((w) => w.placement === "aboveEditor");
  const belowWidgets = widgets.filter((w) => w.placement === "belowEditor");

  function addImageFiles(files: FileList | File[] | null) {
    if (!files || !onAddFiles || !canAttachImages) return;
    const images = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (images.length > 0) onAddFiles(images);
  }

  // Live path search while the @ picker is open (HOY-220), debounced so each
  // keystroke does not fire an ipc round trip. Empty query returns the first
  // paths (Rust caps the count).
  useEffect(() => {
    if (!picker || !searchPaths) {
      setPathResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      searchPaths(picker.query)
        .then((results) => {
          if (!cancelled) setPathResults(results);
        })
        .catch(() => {
          if (!cancelled) setPathResults([]);
        });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [picker, searchPaths]);

  // Anchor the menu at the @ caret (HOY-220). Measured after layout so the
  // textarea value and caret are current; recomputed as the query grows.
  useLayoutEffect(() => {
    if (!picker) {
      setMenuPos(null);
      return;
    }
    const el = textareaRef.current;
    if (!el) return;
    const caret = getCaretCoordinates(el, picker.at);
    const rect = el.getBoundingClientRect();
    const caretTop = rect.top + caret.top;
    const caretBottom = caretTop + caret.height;
    const MENU_MAX = 300;
    const GAP = 6;
    const MENU_WIDTH = 352;
    const left = Math.max(
      8,
      Math.min(rect.left + caret.left, window.innerWidth - MENU_WIDTH - 8),
    );
    if (caretTop >= MENU_MAX + GAP) {
      setMenuPos({ left, bottom: window.innerHeight - caretTop + GAP });
    } else {
      setMenuPos({ left, top: caretBottom + GAP });
    }
  }, [picker]);

  const query = picker?.query.toLowerCase() ?? "";
  const shownPaths = pathResults.slice(0, 8);
  const shownThreads = (
    query
      ? threads.filter((t) => t.title.toLowerCase().includes(query))
      : threads
  ).slice(0, 6);

  // Reflect the textarea's current @-mention (or clear it) after every edit.
  function handleChange(value: string, cursor: number) {
    onChange(value);
    const mention = detectMention(value, cursor);
    setPicker(mention ? { at: mention.at, query: mention.query } : null);
  }

  // The @ button opens the picker by inserting an `@` at the cursor (on a word
  // boundary), which the mention detector then picks up.
  function openPickerFromButton() {
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    const pos = el.selectionStart ?? value.length;
    const needsSpace = pos > 0 && !/\s/.test(value[pos - 1] ?? "");
    const insert = `${needsSpace ? " " : ""}@`;
    const next = value.slice(0, pos) + insert + value.slice(pos);
    const at = pos + insert.length - 1;
    onChange(next);
    setPicker({ at, query: "" });
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = at + 1;
    });
  }

  // Remove the `@query` token from the textarea and close the picker, restoring
  // the caret to where the `@` was.
  function closePicker() {
    if (picker) {
      const end = picker.at + 1 + picker.query.length;
      onChange(value.slice(0, picker.at) + value.slice(end));
      const el = textareaRef.current;
      if (el)
        requestAnimationFrame(() => {
          el.focus();
          el.selectionStart = el.selectionEnd = picker.at;
        });
    }
    setPicker(null);
    setPathResults([]);
  }

  function pickPath(entry: PathEntry) {
    onAddContext?.({
      kind: entry.isDir ? "directory" : "file",
      path: entry.path,
      name: entry.name,
    });
    closePicker();
  }

  function pickThread(thread: ContextThread) {
    onAddContext?.({
      kind: "thread",
      threadId: thread.threadId,
      title: thread.title,
    });
    closePicker();
  }

  function pickImage() {
    closePicker();
    fileInputRef.current?.click();
  }

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
    // The @ picker takes keys first (HOY-220): Escape closes it, Enter selects
    // the top match instead of sending the message.
    if (picker) {
      if (e.key === "Escape") {
        e.preventDefault();
        closePicker();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (shownPaths.length > 0) pickPath(shownPaths[0]);
        else if (shownThreads.length > 0) pickThread(shownThreads[0]);
        else closePicker();
        return;
      }
    }
    if (e.key !== "Enter") return;
    if (!e.shiftKey) {
      e.preventDefault();
      if (canSend) onSubmit?.("enter");
    } else if (streaming) {
      // Shift+Enter queues a follow-up mid-turn (HOY-218). When idle it keeps
      // its normal newline behavior.
      e.preventDefault();
      if (canSend) onSubmit?.("shiftEnter");
    }
  }

  const canSend =
    !disabled &&
    (value.trim().length > 0 ||
      attachments.length > 0 ||
      contexts.length > 0);

  return (
    <div
      className={cn("relative flex min-h-0 flex-col", fill && "h-full")}
      onDragOver={(e) => {
        if (!canAttachImages || !onAddFiles) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        if (!canAttachImages || !onAddFiles) return;
        e.preventDefault();
        setDragging(false);
        addImageFiles(e.dataTransfer.files);
      }}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-10 rounded-md border-2 border-dashed border-brand/50 bg-brand/5" />
      )}
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

      {aboveWidgets.map((w, i) => (
        <WidgetPanel key={`above-${i}`} lines={w.lines} />
      ))}

      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 px-3 pt-3">
          {attachments.map((a) => (
            <div
              key={a.id}
              className="group relative size-16 overflow-hidden rounded-md border border-border/60"
            >
              <img
                src={a.previewUrl}
                alt={a.name}
                className="size-full object-cover"
              />
              <button
                type="button"
                aria-label={`Remove ${a.name}`}
                onClick={() => onRemoveAttachment?.(a.id)}
                className="absolute right-0.5 top-0.5 rounded-full bg-background/80 p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {contexts.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-3 pt-3">
          {contexts.map((ref) => (
            <ContextPill
              key={contextKey(ref)}
              contextRef={ref}
              onRemove={() => onRemoveContext?.(contextKey(ref))}
            />
          ))}
        </div>
      )}

      <textarea
        ref={textareaRef}
        rows={fill ? undefined : 1}
        value={value}
        onChange={(e) =>
          handleChange(e.target.value, e.target.selectionStart ?? e.target.value.length)
        }
        onKeyDown={handleKeyDown}
        onPaste={(e) => {
          if (!canAttachImages || !onAddFiles) return;
          const files = Array.from(e.clipboardData.files);
          if (files.some((f) => f.type.startsWith("image/"))) addImageFiles(files);
        }}
        autoFocus={autoFocus}
        disabled={disabled}
        placeholder={
          streaming
            ? "Enter to steer  ·  Shift+Enter to queue a follow-up"
            : disabled
              ? "Streaming response..."
              : placeholder
        }
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

      {belowWidgets.map((w, i) => (
        <WidgetPanel key={`below-${i}`} lines={w.lines} />
      ))}

      {picker && menuPos && (
        <div
          // Keep the textarea focused so typing keeps updating the @query.
          onMouseDown={(e) => e.preventDefault()}
          style={{
            position: "fixed",
            left: menuPos.left,
            top: menuPos.top,
            bottom: menuPos.bottom,
          }}
          className="scrollbar-thin z-50 max-h-[300px] w-[22rem] max-w-[calc(100vw-1rem)] overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <PickerSection label="Files & Directories">
            {shownPaths.length === 0 ? (
              <PickerEmpty>No matching files</PickerEmpty>
            ) : (
              shownPaths.map((entry) => (
                <PickerRow key={entry.path} onSelect={() => pickPath(entry)}>
                  {entry.isDir ? (
                    <Folder className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate">{entry.name}</span>
                  <span className="ml-auto truncate pl-2 text-xs text-muted-foreground/70">
                    {entry.path}
                  </span>
                </PickerRow>
              ))
            )}
          </PickerSection>

          {shownThreads.length > 0 && (
            <PickerSection label="Threads">
              {shownThreads.map((thread) => (
                <PickerRow
                  key={thread.threadId}
                  onSelect={() => pickThread(thread)}
                >
                  <MessageSquare className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{thread.title}</span>
                </PickerRow>
              ))}
            </PickerSection>
          )}

          {canAttachImages && (
            <PickerSection label="Image">
              <PickerRow onSelect={pickImage}>
                <ImageIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">Attach an image...</span>
              </PickerRow>
            </PickerSection>
          )}
        </div>
      )}

      <div className="flex items-center justify-between gap-2 px-2 py-1.5">
        <div className="flex items-center gap-0.5">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              addImageFiles(e.target.files);
              e.target.value = "";
            }}
          />
          {canAttachImages && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              aria-label="Attach image"
              onClick={() => fileInputRef.current?.click()}
            >
              <Plus className="size-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            aria-label="Mention context"
            onClick={openPickerFromButton}
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
            value={THINKING_LABELS[thinking]}
            options={THINKING_LEVELS.map((l) => THINKING_LABELS[l])}
            onSelect={(label) => {
              const level = THINKING_LEVELS.find(
                (l) => THINKING_LABELS[l] === label,
              );
              if (level) onSelectThinking(level);
            }}
          />
          {streaming && onStop && (
            <Button
              variant="outline"
              size="icon-sm"
              className="ml-1 rounded-md border-destructive/40 text-destructive hover:text-destructive"
              onClick={onStop}
              aria-label="Stop"
            >
              <Square className="size-4" />
            </Button>
          )}
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
            onClick={() => canSend && onSubmit?.("enter")}
            aria-label="Send"
          >
            <SendHorizontal className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

// A removable @ context pill above the editor (HOY-220). Files/dirs show the
// leaf name, threads show the title.
function ContextPill({
  contextRef,
  onRemove,
}: {
  contextRef: ContextRef;
  onRemove: () => void;
}) {
  const Icon =
    contextRef.kind === "thread"
      ? MessageSquare
      : contextRef.kind === "directory"
        ? Folder
        : FileIcon;
  const label = contextRef.kind === "thread" ? contextRef.title : contextRef.name;
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/60 bg-muted/40 py-0.5 pl-1.5 pr-1 text-xs text-muted-foreground">
      <Icon className="size-3 shrink-0" />
      <span className="truncate">{label}</span>
      <button
        type="button"
        aria-label={`Remove ${label}`}
        onClick={onRemove}
        className="shrink-0 rounded-full p-0.5 hover:text-foreground"
      >
        <X className="size-3" />
      </button>
    </span>
  );
}

function PickerSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="py-0.5">
      <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
        {label}
      </div>
      {children}
    </div>
  );
}

function PickerRow({
  onSelect,
  children,
}: {
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-foreground hover:bg-accent"
    >
      {children}
    </button>
  );
}

function PickerEmpty({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2 py-1.5 text-sm text-muted-foreground/70">{children}</div>
  );
}

// An extension setWidget panel: muted, monospace, multi-line, docked at the
// edge of the editor.
function WidgetPanel({ lines }: { lines: string[] }) {
  return (
    <div className="mx-2 mt-1.5 rounded-md border border-border/60 bg-muted/30 px-2.5 py-1.5 font-mono text-xs leading-relaxed text-muted-foreground">
      {lines.map((line, i) => (
        <div key={i} className="whitespace-pre-wrap">
          {line}
        </div>
      ))}
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
