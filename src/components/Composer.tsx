import { useEffect, useRef, useState } from "react";
import {
  AtSign,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Code,
  File as FileIcon,
  Folder,
  GitBranch,
  Image as ImageIcon,
  Maximize2,
  MessageSquare,
  Minimize2,
  Plus,
  SendHorizontal,
  Sparkles,
  Square,
  TextCursor,
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
import {
  draftIsEmpty,
  draftToParts,
  mentionLabel,
  mentionMarker,
} from "@/lib/mentions";
import { addRecentContext, getRecentContexts } from "@/lib/recentContexts";
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

// --- @ mention chips (HOY-220): rendered inline in the contenteditable editor
// as atomic, non-editable elements. Backspace deletes the whole chip. The chip's
// DOM carries the ContextRef in data-* so the editor serializes back to a draft.

const MENTION_CLASS =
  "mention-chip mx-px inline-flex items-center gap-1 rounded border border-border/70 bg-muted/60 px-1 align-middle text-[0.9em] text-foreground";

const ICON_SVG: Record<ContextRef["kind"], string> = {
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  directory:
    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  thread:
    '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
};

function svgFor(kind: ContextRef["kind"]): string {
  return `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex:none;opacity:0.7">${ICON_SVG[kind]}</svg>`;
}

function createChip(ref: ContextRef): HTMLElement {
  const span = document.createElement("span");
  span.setAttribute("data-mention", "1");
  span.setAttribute("contenteditable", "false");
  span.dataset.kind = ref.kind;
  if (ref.kind === "thread") {
    span.dataset.threadId = ref.threadId;
    span.dataset.title = ref.title;
  } else {
    span.dataset.path = ref.path;
    span.dataset.name = ref.name;
  }
  span.className = MENTION_CLASS;
  span.innerHTML = svgFor(ref.kind);
  span.appendChild(document.createTextNode(mentionLabel(ref)));
  return span;
}

function chipToRef(el: HTMLElement): ContextRef {
  const kind = el.dataset.kind;
  if (kind === "thread") {
    return {
      kind: "thread",
      threadId: el.dataset.threadId ?? "",
      title: el.dataset.title ?? "",
    };
  }
  return {
    kind: kind === "directory" ? "directory" : "file",
    path: el.dataset.path ?? "",
    name: el.dataset.name ?? "",
  };
}

function pathToRef(entry: PathEntry): ContextRef {
  return {
    kind: entry.isDir ? "directory" : "file",
    path: entry.path,
    name: entry.name,
  };
}

// Zed-style agent composer. The message editor is a contenteditable surface so @
// mentions render as inline chips (HOY-220). `fill` makes it expand to fill the
// panel (the empty thread state); otherwise it auto-grows up to a cap and docks
// at the bottom of an active thread.
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
  searchPaths,
  threads = [],
  projectPath,
}: {
  // The draft, with @ mentions encoded inline as markers (lib/mentions.ts).
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
  // @ context picker (HOY-220): the gitignore-aware path search, the thread list
  // for the Threads section, and the project path (keys the Recent section).
  // Selected refs become inline chips in the draft.
  searchPaths?: (query: string) => Promise<PathEntry[]>;
  threads?: ContextThread[];
  projectPath?: string | null;
}) {
  const editorRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Last draft we emitted, so the value->DOM sync effect can tell our own edits
  // (skip, keep the caret) from external ones (rebuild: clear-on-submit, restore,
  // extension setEditorText).
  const lastEmitted = useRef<string | null>(null);
  const [dragging, setDragging] = useState(false);
  // Active @-mention (HOY-220): the picker is open while this is set; `query`
  // filters the results. `view` is the drill-down: "root" shows Recent +
  // category rows (empty query), "files"/"threads" browse one category. A
  // non-empty query always shows live search regardless of view. The exact @
  // position is recomputed from the live caret at insert time.
  const [picker, setPicker] = useState<{
    query: string;
    view: "root" | "files" | "threads";
  } | null>(null);
  const [pathResults, setPathResults] = useState<PathEntry[]>([]);
  const [recents, setRecents] = useState<ContextRef[]>([]);
  // Fixed-viewport position for the picker menu, anchored at the @ caret.
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

  // Serialize the editor DOM back to a draft string (text + mention markers).
  function serialize(): string {
    const root = editorRef.current;
    if (!root) return "";
    let out = "";
    root.childNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        out += node.textContent ?? "";
      } else if (node.nodeName === "BR") {
        out += "\n";
      } else if (node instanceof HTMLElement) {
        out += node.dataset.mention
          ? mentionMarker(chipToRef(node))
          : (node.textContent ?? "");
      }
    });
    return out;
  }

  function emit() {
    const draft = serialize();
    lastEmitted.current = draft;
    onChange(draft);
  }

  // The active @-mention at the caret, or null. Reused by the picker open/update
  // and by insertion/dismissal so all three agree on the token bounds.
  function currentMention(): {
    node: Text;
    at: number;
    offset: number;
    query: string;
  } | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
    const node = sel.anchorNode;
    const root = editorRef.current;
    if (!node || node.nodeType !== Node.TEXT_NODE) return null;
    if (!root || !root.contains(node)) return null;
    const offset = sel.anchorOffset;
    const detected = detectMention(node.textContent ?? "", offset);
    if (!detected) return null;
    return { node: node as Text, at: detected.at, offset, query: detected.query };
  }

  function computeMenuPos(): {
    left: number;
    top?: number;
    bottom?: number;
  } | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0).cloneRange();
    const rects = range.getClientRects();
    let rect: DOMRect | undefined = rects[0] ?? range.getBoundingClientRect();
    if (!rect || (rect.top === 0 && rect.left === 0 && rect.height === 0)) {
      rect = editorRef.current?.getBoundingClientRect();
    }
    if (!rect) return null;
    const MENU_MAX = 300;
    const GAP = 6;
    const MENU_WIDTH = 352;
    const left = Math.max(
      8,
      Math.min(rect.left, window.innerWidth - MENU_WIDTH - 8),
    );
    if (rect.top >= MENU_MAX + GAP) {
      return { left, bottom: window.innerHeight - rect.top + GAP };
    }
    return { left, top: rect.bottom + GAP };
  }

  // Reflect the caret's @-mention (open/update/close the picker) after any edit.
  function updateMention() {
    const mention = currentMention();
    if (mention) {
      setPicker((prev) => ({
        query: mention.query,
        view: prev?.view ?? "root",
      }));
      setMenuPos(computeMenuPos());
    } else {
      setPicker(null);
    }
  }

  function setView(view: "root" | "files" | "threads") {
    setPicker((p) => (p ? { ...p, view } : p));
  }

  function insertTextAtCaret(text: string) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    // Caret INSIDE the text node (not setStartAfter, which lands on the parent
    // element): currentMention only detects an @ when the caret's anchor is a
    // text node, so the @ button must leave the caret there for the menu to open.
    range.setStart(node, node.data.length);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    emit();
    updateMention();
  }

  // Replace the @query at the caret with an inline chip, then a trailing space so
  // the caret has a spot to keep typing after the chip.
  function insertMention(ref: ContextRef) {
    const root = editorRef.current;
    const mention = currentMention();
    if (!root || !mention) {
      dismissPicker();
      return;
    }
    const range = document.createRange();
    range.setStart(mention.node, mention.at);
    range.setEnd(mention.node, mention.offset);
    range.deleteContents();
    const frag = document.createDocumentFragment();
    frag.appendChild(createChip(ref));
    const space = document.createTextNode(" ");
    frag.appendChild(space);
    range.insertNode(frag);
    const after = document.createRange();
    after.setStartAfter(space);
    after.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(after);
    setPicker(null);
    setPathResults([]);
    addRecentContext(projectPath, ref);
    emit();
    root.focus();
  }

  // Close the menu, leaving the typed @query text in place (Escape / blur).
  function dismissPicker() {
    setPicker(null);
    setPathResults([]);
  }

  function openPickerFromButton() {
    const root = editorRef.current;
    if (!root) return;
    root.focus();
    const sel = window.getSelection();
    if (!sel) return;
    if (sel.rangeCount === 0 || !root.contains(sel.anchorNode)) {
      const range = document.createRange();
      range.selectNodeContents(root);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    const node = sel.anchorNode;
    const offset = sel.anchorOffset;
    let insert = "@";
    if (node && node.nodeType === Node.TEXT_NODE && offset > 0) {
      const prev = (node.textContent ?? "")[offset - 1];
      if (prev && !/\s/.test(prev)) insert = " @";
    }
    insertTextAtCaret(insert);
  }

  function pickImage() {
    dismissPicker();
    fileInputRef.current?.click();
  }

  // Live path search while the picker is open (debounced). Empty query returns
  // the first paths (Rust caps the count).
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

  // Load the Recent section when the picker opens (and after an insert reopens it).
  const pickerOpen = !!picker;
  useEffect(() => {
    if (pickerOpen) setRecents(getRecentContexts(projectPath));
  }, [pickerOpen, projectPath]);

  // Sync external draft changes into the editor DOM (init, clear-on-submit,
  // restore, setEditorText). Our own edits set lastEmitted first, so they are
  // skipped here and the caret is preserved.
  useEffect(() => {
    const root = editorRef.current;
    if (!root) return;
    if (value === lastEmitted.current) return;
    root.textContent = "";
    for (const part of draftToParts(value)) {
      if (part.type === "text") {
        root.appendChild(document.createTextNode(part.text));
      } else {
        root.appendChild(createChip(part.ref));
      }
    }
    lastEmitted.current = value;
    if (document.activeElement === root) {
      const range = document.createRange();
      range.selectNodeContents(root);
      range.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  }, [value]);

  // Click-driven focus: a non-zero signal focuses, including on mount. preventScroll
  // so it does not fight ThreadView's smooth scrollIntoView.
  useEffect(() => {
    if (focusSignal) editorRef.current?.focus({ preventScroll: true });
  }, [focusSignal]);

  const query = picker?.query.toLowerCase() ?? "";
  const view = picker?.view ?? "root";
  const showSearch = query.length > 0;
  const shownPaths = pathResults.slice(0, 8);
  const shownThreads = (
    query
      ? threads.filter((t) => t.title.toLowerCase().includes(query))
      : threads
  ).slice(0, 8);

  const renderFileRows = () =>
    shownPaths.length === 0 ? (
      <PickerEmpty>No matching files</PickerEmpty>
    ) : (
      shownPaths.map((entry) => (
        <PickerRow
          key={entry.path}
          onSelect={() => insertMention(pathToRef(entry))}
        >
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
    );

  const renderThreadRows = () =>
    shownThreads.length === 0 ? (
      <PickerEmpty>No threads</PickerEmpty>
    ) : (
      shownThreads.map((thread) => (
        <PickerRow
          key={thread.threadId}
          onSelect={() =>
            insertMention({
              kind: "thread",
              threadId: thread.threadId,
              title: thread.title,
            })
          }
        >
          <MessageSquare className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{thread.title}</span>
        </PickerRow>
      ))
    );

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    // The @ picker takes keys first (HOY-220): Escape closes it, Enter selects
    // the top match instead of sending.
    if (picker) {
      if (e.key === "Escape") {
        e.preventDefault();
        dismissPicker();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (shownPaths.length > 0) insertMention(pathToRef(shownPaths[0]));
        else if (shownThreads.length > 0) {
          const t = shownThreads[0];
          insertMention({ kind: "thread", threadId: t.threadId, title: t.title });
        } else dismissPicker();
        return;
      }
    }
    if (e.key !== "Enter") return;
    if (!e.shiftKey) {
      e.preventDefault();
      if (canSend) onSubmit?.("enter");
    } else if (streaming) {
      // Shift+Enter queues a follow-up mid-turn (HOY-218).
      e.preventDefault();
      if (canSend) onSubmit?.("shiftEnter");
    } else {
      // Idle Shift+Enter: a controlled newline (keeps the editor free of stray
      // block wrappers so serialization stays clean).
      e.preventDefault();
      insertTextAtCaret("\n");
    }
  }

  const canSend =
    !disabled && (!draftIsEmpty(value) || attachments.length > 0);
  const showPlaceholder = draftIsEmpty(value);
  const placeholderText = streaming
    ? "Enter to steer  ·  Shift+Enter to queue a follow-up"
    : disabled
      ? "Streaming response..."
      : placeholder;

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

      <div className={cn("relative", fill && "min-h-0 flex-1")}>
        <div
          ref={editorRef}
          role="textbox"
          aria-multiline="true"
          contentEditable={!disabled}
          suppressContentEditableWarning
          autoFocus={autoFocus}
          onInput={() => {
            emit();
            updateMention();
          }}
          onKeyDown={handleKeyDown}
          onBlur={dismissPicker}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files);
            if (
              canAttachImages &&
              onAddFiles &&
              files.some((f) => f.type.startsWith("image/"))
            ) {
              e.preventDefault();
              addImageFiles(files);
              return;
            }
            // Insert clipboard text as plain text so pasted HTML never pollutes
            // the editor (which would break serialization).
            e.preventDefault();
            insertTextAtCaret(e.clipboardData.getData("text/plain"));
          }}
          className={cn(
            "scrollbar-thin w-full whitespace-pre-wrap break-words bg-transparent pl-4 pt-3.5 text-sm leading-6 text-foreground focus:outline-none",
            fill
              ? cn("h-full overflow-y-auto", onToggleExpand ? "pr-10" : "pr-4")
              : "max-h-[240px] min-h-[80px] overflow-y-auto pr-10",
          )}
        />
        {showPlaceholder && (
          <div className="pointer-events-none absolute left-4 top-3.5 text-sm leading-6 text-muted-foreground/70">
            {placeholderText}
          </div>
        )}
      </div>

      {belowWidgets.map((w, i) => (
        <WidgetPanel key={`below-${i}`} lines={w.lines} />
      ))}

      {picker && menuPos && (
        <div
          // Keep the editor focused so typing keeps updating the @query.
          onMouseDown={(e) => e.preventDefault()}
          style={{
            position: "fixed",
            left: menuPos.left,
            top: menuPos.top,
            bottom: menuPos.bottom,
          }}
          className="scrollbar-thin z-50 max-h-[320px] w-[22rem] max-w-[calc(100vw-1rem)] overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {showSearch ? (
            <>
              <PickerSection label="Files & Directories">
                {renderFileRows()}
              </PickerSection>
              {shownThreads.length > 0 && (
                <PickerSection label="Threads">{renderThreadRows()}</PickerSection>
              )}
            </>
          ) : view === "files" ? (
            <>
              <BackRow onBack={() => setView("root")} />
              <PickerSection label="Files & Directories">
                {renderFileRows()}
              </PickerSection>
            </>
          ) : view === "threads" ? (
            <>
              <BackRow onBack={() => setView("root")} />
              <PickerSection label="Threads">{renderThreadRows()}</PickerSection>
            </>
          ) : (
            <>
              {recents.length > 0 && (
                <>
                  <PickerSection label="Recent">
                    {recents.map((ref) => (
                      <RecentRow
                        key={contextKey(ref)}
                        contextRef={ref}
                        onSelect={() => insertMention(ref)}
                      />
                    ))}
                  </PickerSection>
                  <div className="my-1 border-t border-border/60" />
                </>
              )}
              <div className="py-0.5">
                <CategoryRow
                  icon={<Folder className="size-4 shrink-0 text-muted-foreground" />}
                  label="Files & Directories"
                  chevron
                  onSelect={() => setView("files")}
                />
                <CategoryRow
                  icon={<Code className="size-4 shrink-0" />}
                  label="Symbols"
                  disabled
                />
                <CategoryRow
                  icon={
                    <MessageSquare className="size-4 shrink-0 text-muted-foreground" />
                  }
                  label="Threads"
                  chevron
                  onSelect={() => setView("threads")}
                />
                <CategoryRow
                  icon={<Sparkles className="size-4 shrink-0" />}
                  label="Skills"
                  disabled
                />
                {canAttachImages && (
                  <CategoryRow
                    icon={
                      <ImageIcon className="size-4 shrink-0 text-muted-foreground" />
                    }
                    label="Image"
                    onSelect={pickImage}
                  />
                )}
                <CategoryRow
                  icon={<TextCursor className="size-4 shrink-0" />}
                  label="Selection"
                  disabled
                />
                <CategoryRow
                  icon={<GitBranch className="size-4 shrink-0" />}
                  label="Branch Diff"
                  disabled
                />
              </div>
            </>
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

// A recently used @ context (HOY-220). Clock icon + label + dimmed secondary,
// mirroring Zed's Recent section.
function RecentRow({
  contextRef,
  onSelect,
}: {
  contextRef: ContextRef;
  onSelect: () => void;
}) {
  const secondary = contextRef.kind === "thread" ? "thread" : contextRef.path;
  return (
    <PickerRow onSelect={onSelect}>
      <Clock className="size-4 shrink-0 text-muted-foreground" />
      <span className="truncate">{mentionLabel(contextRef)}</span>
      <span className="ml-auto truncate pl-2 text-xs text-muted-foreground/70">
        {secondary}
      </span>
    </PickerRow>
  );
}

// A category row in the picker's root view. Supported categories drill in (chevron)
// or act; deferred ones render dimmed and inert to match Zed's menu (HOY-220).
function CategoryRow({
  icon,
  label,
  chevron = false,
  disabled = false,
  onSelect,
}: {
  icon: React.ReactNode;
  label: string;
  chevron?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
}) {
  if (disabled) {
    return (
      <div className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-muted-foreground/40">
        {icon}
        <span>{label}</span>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-foreground hover:bg-accent"
    >
      {icon}
      <span>{label}</span>
      {chevron && (
        <ChevronRight className="ml-auto size-4 text-muted-foreground/50" />
      )}
    </button>
  );
}

function BackRow({ onBack }: { onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className="flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
    >
      <ChevronLeft className="size-3.5" />
      Back
    </button>
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
