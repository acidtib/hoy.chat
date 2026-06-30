import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  Archive,
  CircleStop,
  FilePen,
  Info,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Plus,
  Search,
  ShieldQuestion,
  Sparkle,
  Terminal,
  TriangleAlert,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import { Tool, ToolContent, ToolHeader } from "@/components/ai-elements/tool";
import { CodeBlock } from "@/components/ai-elements/code-block";
import { Composer } from "@/components/Composer";
import { InlineRename } from "@/components/InlineRename";
import { cn } from "@/lib/utils";
import { findThread, useSessionStore } from "@/state/store";
import type {
  ExtWidget,
  Notice,
  PermissionRequest,
  PiState,
  ToolUI,
  Turn,
} from "@/lib/types";

// Stable empty references so selectors don't return a fresh value each render
// (which would loop zustand's snapshot equality check).
const EMPTY_TURNS: Turn[] = [];
const EMPTY_PERMISSIONS: PermissionRequest[] = [];
const EMPTY_NOTICES: Notice[] = [];

export function ThreadView({
  threadId,
  active,
  onClose,
  onDebug,
  busy,
  debug,
  error,
}: {
  threadId: string;
  active: boolean;
  onClose: () => void;
  onDebug: (sessionId?: string | null) => void;
  busy: boolean;
  debug: PiState | null;
  error: string | null;
}) {
  const projects = useSessionStore((s) => s.projects);
  const addThread = useSessionStore((s) => s.addThread);
  const requestTeardown = useSessionStore((s) => s.requestTeardown);
  const turns = useSessionStore((s) => s.turns[threadId] ?? EMPTY_TURNS);
  const streaming = useSessionStore((s) => s.streaming[threadId] ?? false);
  const threadError = useSessionStore((s) => s.threadErrors[threadId] ?? null);
  const submitPrompt = useSessionStore((s) => s.submitPrompt);
  const renameThread = useSessionStore((s) => s.renameThread);
  const models = useSessionStore((s) => s.models);
  const defaultModel = useSessionStore((s) => s.defaultModel);
  const selecting = useSessionStore((s) => s.modelSelecting[threadId] ?? false);
  const selectModel = useSessionStore((s) => s.selectModel);
  const selectThinkingLevel = useSessionStore((s) => s.selectThinkingLevel);
  const fullScreen = useSessionStore((s) => s.expandedThreadId === threadId);
  const toggleFullScreen = useSessionStore((s) => s.toggleFullScreen);
  const pendingPermissions = useSessionStore(
    (s) => s.pendingPermissions[threadId] ?? EMPTY_PERMISSIONS,
  );
  const setPermissionMode = useSessionStore((s) => s.setPermissionMode);
  const answerPermission = useSessionStore((s) => s.answerPermission);
  const notices = useSessionStore((s) => s.notices[threadId] ?? EMPTY_NOTICES);
  const dismissNotice = useSessionStore((s) => s.dismissNotice);
  const threadWidgets = useSessionStore((s) => s.widgets[threadId]);
  const stopStreaming = useSessionStore((s) => s.stopStreaming);
  const focusSignal = useSessionStore((s) =>
    s.focusRequest?.threadId === threadId ? s.focusRequest.nonce : 0,
  );
  const draft = useSessionStore((s) => s.drafts[threadId] ?? "");
  const setDraft = useSessionStore((s) => s.setDraft);
  const [editingTitle, setEditingTitle] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const { title, projectId, threadModel, permissionMode, thinkingLevel, sessionId } = useMemo(() => {
    const found = findThread(projects, threadId);
    return {
      title: found?.thread.title ?? "New thread",
      projectId: found?.project.id ?? null,
      threadModel: found?.thread.model ?? null,
      permissionMode: found?.thread.permissionMode ?? ("default" as const),
      thinkingLevel: found?.thread.thinkingLevel ?? ("high" as const),
      sessionId: found?.thread.sessionId ?? null,
    };
  }, [projects, threadId]);

  const hasMessages = turns.length > 0;
  const shownError = threadError ?? error;

  // Scroll the panel into view when this thread is the focus request target
  // (sidebar/history click or fresh open). Composer handles the focus itself
  // via the same signal.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusSignal) return;
    rootRef.current?.scrollIntoView({
      behavior: "smooth",
      inline: "nearest",
      block: "nearest",
    });
  }, [focusSignal]);

  function handleSubmit() {
    const message = draft;
    setDraft(threadId, "");
    void submitPrompt(threadId, message);
  }

  const widgetList: ExtWidget[] = threadWidgets
    ? Object.values(threadWidgets)
    : [];
  const composer = (
    <Composer
      value={draft}
      onChange={(value) => setDraft(threadId, value)}
      onSubmit={handleSubmit}
      models={models}
      currentModel={threadModel ?? defaultModel}
      selecting={selecting}
      onSelectModel={(provider, modelId) =>
        void selectModel(threadId, provider, modelId)
      }
      mode={permissionMode}
      onSelectMode={(mode) => void setPermissionMode(threadId, mode)}
      thinking={thinkingLevel}
      onSelectThinking={(level) => void selectThinkingLevel(threadId, level)}
      onStop={streaming ? () => void stopStreaming(threadId) : undefined}
      fill={!hasMessages || expanded}
      autoFocus={!hasMessages}
      disabled={streaming}
      expanded={expanded}
      onToggleExpand={hasMessages ? () => setExpanded((v) => !v) : undefined}
      focusSignal={focusSignal}
      widgets={widgetList}
    />
  );

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 px-1 py-0.5">
          <Sparkle
            className={cn(
              "size-4 shrink-0",
              active ? "text-brand" : "text-muted-foreground",
            )}
          />
          {editingTitle ? (
            <InlineRename
              initial={title}
              onCommit={(value) => renameThread(threadId, value)}
              onClose={() => setEditingTitle(false)}
              className="w-full min-w-0 text-sm font-medium"
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditingTitle(true)}
              title="Rename thread"
              className="cursor-text truncate text-sm font-medium text-foreground"
            >
              {title}
            </button>
          )}
        </div>

        <div className="flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                onClick={() => projectId && addThread(projectId)}
                disabled={!projectId}
                aria-label="New thread"
              >
                <Plus className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>New thread</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                onClick={() => toggleFullScreen(threadId)}
                aria-label={fullScreen ? "Exit Full Screen" : "Full Screen"}
              >
                {fullScreen ? (
                  <Minimize2 className="size-3.5" />
                ) : (
                  <Maximize2 className="size-3.5" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {fullScreen ? "Exit Full Screen" : "Full Screen"}
            </TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                aria-label="Thread menu"
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              <DropdownMenuItem
                onSelect={() => requestTeardown("archive", threadId)}
              >
                <Archive className="size-4" />
                Archive thread
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onDebug(sessionId)} disabled={busy}>
                <Activity className="size-4" />
                {busy ? "Calling get_state..." : "Debug: get_state"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                onClick={onClose}
                aria-label="Close panel"
              >
                <X className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Close panel</TooltipContent>
          </Tooltip>
        </div>
      </header>

      {shownError && (
        <div className="mx-3 mt-3 flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span className="leading-relaxed">{shownError}</span>
        </div>
      )}

      {hasMessages ? (
        <>
          <Conversation>
            <ConversationContent className="w-full gap-4 px-3 py-3">
              {debug && (
                <div className="rounded-xl border border-border bg-card/60">
                  <div className="flex items-center justify-between gap-2 px-4 py-3 text-xs font-medium text-muted-foreground">
                    <span className="flex items-center gap-2 uppercase tracking-wider">
                      <span
                        className="size-1.5 rounded-full bg-brand"
                        aria-hidden
                      />
                      get_state round-trip
                    </span>
                    <span className="text-[11px] tabular-nums text-muted-foreground/70">
                      session {debug.sessionId.slice(0, 8)}
                    </span>
                  </div>
                  <pre className="scrollbar-thin overflow-x-auto border-t border-border px-4 py-3 font-mono text-xs leading-relaxed text-card-foreground/90">
                    {JSON.stringify(debug, null, 2)}
                  </pre>
                </div>
              )}

              {turns.map((turn, i) =>
                turn.role === "user" ? (
                  <div
                    key={i}
                    className="whitespace-pre-wrap rounded-md border border-border/60 bg-card/40 px-3 py-2 text-sm leading-relaxed text-foreground"
                  >
                    {turn.text}
                  </div>
                ) : (
                  <Message from="assistant" key={i} className="max-w-full">
                    <MessageContent className="w-full">
                      {turn.reasoning && (
                        <Reasoning
                          defaultOpen={false}
                          duration={turn.reasoning.seconds}
                        >
                          <ReasoningTrigger />
                          <ReasoningContent>
                            {turn.reasoning.text}
                          </ReasoningContent>
                        </Reasoning>
                      )}
                      {turn.blocks.map((block, bi) =>
                        block.kind === "text" ? (
                          <MessageResponse key={bi}>{block.content}</MessageResponse>
                        ) : (
                          <ToolCall tool={block.tool} key={block.tool.id} />
                        ),
                      )}
                      {turn.streaming &&
                        turn.blocks.length === 0 &&
                        !turn.aborted && (
                          <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                            <span className="size-1.5 animate-pulse rounded-full bg-brand" />
                            Working...
                          </span>
                        )}
                      {turn.aborted && (
                        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                          <CircleStop className="size-3.5" />
                          Stopped
                        </span>
                      )}
                      {turn.error && (
                        <div className="mt-1 flex items-start gap-1.5 text-xs text-destructive">
                          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                          <span className="leading-relaxed">{turn.error}</span>
                        </div>
                      )}
                    </MessageContent>
                  </Message>
                ),
              )}
            </ConversationContent>
            <ConversationScrollButton />
          </Conversation>

          {notices.length > 0 && (
            <div className="mx-3 mb-2 space-y-1.5">
              {notices.map((notice) => (
                <NoticeRow
                  key={notice.id}
                  notice={notice}
                  onDismiss={() => dismissNotice(threadId, notice.id)}
                />
              ))}
            </div>
          )}

          {pendingPermissions.length > 0 && (
            <ApprovalCard
              key={pendingPermissions[0].requestId}
              request={pendingPermissions[0]}
              onAnswer={(answer) =>
                void answerPermission(
                  threadId,
                  pendingPermissions[0].requestId,
                  answer,
                )
              }
            />
          )}

          <div
            className={cn(
              "shrink-0 border-t border-border",
              expanded && "flex h-[90%] flex-col",
            )}
          >
            {composer}
          </div>
        </>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col px-3 pb-2 pt-1">
          {composer}
        </div>
      )}
    </div>
  );
}

// Inline approval/dialog card for a blocked extension UI request (HOY-186).
// confirm -> Yes/No; select -> option buttons; input/editor -> a text field with
// Submit/Cancel. The agent stays paused until answered. Keyed by requestId at
// the mount so a text field's local state resets between dialogs.
function ApprovalCard({
  request,
  onAnswer,
}: {
  request: PermissionRequest;
  onAnswer: (answer: {
    value?: string;
    confirmed?: boolean;
    cancelled?: boolean;
  }) => void;
}) {
  const isText = request.method === "input" || request.method === "editor";
  const choices =
    request.method === "confirm"
      ? [
          { label: "Yes", answer: { confirmed: true } },
          { label: "No", answer: { confirmed: false }, decline: true },
        ]
      : (request.options ?? []).map((option) => ({
          label: option,
          answer: { value: option },
          decline: /deny|block|no\b/i.test(option),
        }));

  return (
    <div className="mx-3 mb-2 shrink-0 rounded-lg border border-brand/40 bg-card/70 px-3 py-2.5">
      <div className="flex items-start gap-2.5">
        <ShieldQuestion className="mt-0.5 size-4 shrink-0 text-brand" />
        <div className="min-w-0 flex-1">
          <div
            className={cn(
              "text-xs leading-relaxed text-foreground",
              !isText && "break-all font-mono",
            )}
          >
            {request.title}
          </div>
          {request.message && (
            <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {request.message}
            </div>
          )}
        </div>
      </div>
      {isText ? (
        <TextDialog request={request} onAnswer={onAnswer} />
      ) : (
        <div className="mt-2 flex items-center justify-end gap-1.5">
          {choices.map((choice) => (
            <Button
              key={choice.label}
              variant={choice.decline ? "ghost" : "outline"}
              size="sm"
              className={cn(
                "h-7 text-xs",
                choice.decline
                  ? "text-muted-foreground hover:text-destructive"
                  : "border-brand/40 text-brand hover:text-brand",
              )}
              onClick={() => onAnswer(choice.answer)}
            >
              {choice.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

// Text entry for input (single line, Enter submits) and editor (multiline,
// Cmd/Ctrl+Enter submits) dialogs. Both answer with {value}.
function TextDialog({
  request,
  onAnswer,
}: {
  request: PermissionRequest;
  onAnswer: (answer: { value?: string; cancelled?: boolean }) => void;
}) {
  const [text, setText] = useState(request.prefill ?? "");
  const multiline = request.method === "editor";
  const submit = () => onAnswer({ value: text });

  return (
    <div className="mt-2 space-y-2">
      {multiline ? (
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoFocus
          rows={5}
          className="scrollbar-thin text-xs"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
        />
      ) : (
        <Input
          value={text}
          placeholder={request.placeholder}
          onChange={(e) => setText(e.target.value)}
          autoFocus
          className="h-8 text-xs"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
      )}
      <div className="flex items-center justify-end gap-1.5">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs text-muted-foreground hover:text-destructive"
          onClick={() => onAnswer({ cancelled: true })}
        >
          Cancel
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 border-brand/40 text-xs text-brand hover:text-brand"
          onClick={submit}
        >
          Submit
        </Button>
      </div>
    </div>
  );
}

// A transient extension `notify` notice, styled by severity and dismissible.
function NoticeRow({
  notice,
  onDismiss,
}: {
  notice: Notice;
  onDismiss: () => void;
}) {
  const Icon =
    notice.type === "error"
      ? AlertCircle
      : notice.type === "warning"
        ? TriangleAlert
        : Info;
  const tone =
    notice.type === "error"
      ? "border-destructive/30 bg-destructive/10 text-destructive"
      : notice.type === "warning"
        ? "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
        : "border-border/60 bg-muted/40 text-muted-foreground";

  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-lg border px-3 py-2 text-xs",
        tone,
      )}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 leading-relaxed">{notice.message}</span>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 opacity-70 hover:opacity-100"
        aria-label="Dismiss notice"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

type ToolKind = "read" | "edit" | "terminal" | "other";

function toolKind(name: string): ToolKind {
  if (/edit|write|create|patch/.test(name)) return "edit";
  if (/terminal|exec|run|command|bash|shell|build/.test(name)) return "terminal";
  if (/read|search|grep|find|list|cat|glob/.test(name)) return "read";
  return "other";
}

function toolIcon(kind: ToolKind): ReactNode {
  if (kind === "read") return <Search />;
  if (kind === "edit") return <FilePen />;
  if (kind === "terminal") return <Terminal />;
  return undefined;
}

// Zed splits tool calls by kind: edit and execute render as bordered cards
// (diff / command + output), everything else is a bare muted row whose output
// shows on expand.
function ToolCall({ tool }: { tool: ToolUI }) {
  const kind = toolKind(tool.name);
  // Every tool renders as a bordered card, open by default so its body (diff,
  // command + output, or result) is visible without a click.
  // The terminal body already shows the command ($ ...), so the header stays a
  // generic tool label (lowercase, like the other tools) instead of repeating it.
  const headerTitle = kind === "terminal" ? tool.name : tool.title;

  return (
    <Tool
      defaultOpen
      className="group my-0.5 overflow-hidden rounded-md border border-border/70"
    >
      <ToolHeader
        title={headerTitle}
        type={`tool-${tool.name}`}
        state={
          tool.pending
            ? "approval-requested"
            : tool.running
              ? "input-available"
              : tool.isError
                ? "output-error"
                : "output-available"
        }
        icon={toolIcon(kind)}
        className="bg-muted/25 px-2 py-1.5 text-foreground"
      />
      <ToolContent className="border-t border-border/70">
        {kind === "edit" && tool.diff ? (
          <CodeBlock
            code={tool.diff}
            language="diff"
            className="rounded-none border-0 bg-transparent"
          />
        ) : kind === "terminal" ? (
          <div className="space-y-1 px-3 py-2 font-mono text-xs leading-relaxed">
            {tool.command && (
              <div className="text-muted-foreground">
                <span className="text-brand">$</span> {tool.command}
              </div>
            )}
            <pre className="scrollbar-thin overflow-x-auto whitespace-pre-wrap text-foreground/80">
              {tool.output}
            </pre>
          </div>
        ) : (
          <pre className="scrollbar-thin overflow-x-auto whitespace-pre-wrap px-3 py-2 font-mono text-xs leading-relaxed text-muted-foreground">
            {tool.output}
          </pre>
        )}
      </ToolContent>
    </Tool>
  );
}
