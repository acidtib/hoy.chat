import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  Archive,
  Check,
  Circle,
  CircleDot,
  CircleStop,
  ClipboardCheck,
  Square,
  File as FileIcon,
  FilePen,
  Folder,
  Info,
  Maximize2,
  MessageSquare,
  Minimize2,
  Minus,
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
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  parseAskPayload,
  type AskAnswer,
  type AskPayload,
  type AskQuestion,
} from "@/lib/ask-question";
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
import { isSubagentThread, childThreadIdsOf } from "@/state/delivery";
import { usePrefsStore } from "@/state/prefs";
import { listProjectPaths } from "@/lib/ipc";
import { contextKey, modelSupportsImages } from "@/lib/types";
import type {
  AssistantBlock,
  ContextRef,
  ExtWidget,
  ImageAttachment,
  Notice,
  PermissionMode,
  PermissionRequest,
  PiState,
  SlashCommand,
  ToolUI,
  Turn,
} from "@/lib/types";

// Stable empty references so selectors don't return a fresh value each render
// (which would loop zustand's snapshot equality check).
const EMPTY_TURNS: Turn[] = [];
const EMPTY_PERMISSIONS: PermissionRequest[] = [];
const EMPTY_NOTICES: Notice[] = [];
const EMPTY_ATTACHMENTS: ImageAttachment[] = [];
const EMPTY_QUEUE: { steering: string[]; followUp: string[] } = {
  steering: [],
  followUp: [],
};
const EMPTY_SLASH: SlashCommand[] = [];

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
  const planReady = useSessionStore((s) => s.planReady[threadId]);
  const implementPlan = useSessionStore((s) => s.implementPlan);
  const dismissPlanReady = useSessionStore((s) => s.dismissPlanReady);
  const notices = useSessionStore((s) => s.notices[threadId] ?? EMPTY_NOTICES);
  const dismissNotice = useSessionStore((s) => s.dismissNotice);
  const expandReasoning = usePrefsStore((s) => s.expandReasoning);
  const threadWidgets = useSessionStore((s) => s.widgets[threadId]);
  const stopStreaming = useSessionStore((s) => s.stopStreaming);
  const focusSignal = useSessionStore((s) =>
    s.focusRequest?.threadId === threadId ? s.focusRequest.nonce : 0,
  );
  const draft = useSessionStore((s) => s.drafts[threadId] ?? "");
  const setDraft = useSessionStore((s) => s.setDraft);
  const attachments = useSessionStore(
    (s) => s.composerAttachments[threadId] ?? EMPTY_ATTACHMENTS,
  );
  const addAttachments = useSessionStore((s) => s.addAttachments);
  const removeAttachment = useSessionStore((s) => s.removeAttachment);
  const queued = useSessionStore((s) => s.queued[threadId] ?? EMPTY_QUEUE);
  const slashCommands = useSessionStore(
    (s) => s.slashCommands[threadId] ?? EMPTY_SLASH,
  );
  const [editingTitle, setEditingTitle] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const { title, projectId, projectPath, threadModel, permissionMode, thinkingLevel, sessionId } = useMemo(() => {
    const found = findThread(projects, threadId);
    return {
      title: found?.thread.title ?? "New thread",
      projectId: found?.project.id ?? null,
      projectPath: found?.project.path ?? null,
      threadModel: found?.thread.model ?? null,
      permissionMode: found?.thread.permissionMode ?? ("default" as const),
      thinkingLevel: found?.thread.thinkingLevel ?? ("high" as const),
      sessionId: found?.thread.sessionId ?? null,
    };
  }, [projects, threadId]);

  const threadIsAgent = (() => {
    const found = findThread(projects, threadId);
    if (!found) return false;
    return (
      isSubagentThread(found.thread) ||
      childThreadIdsOf(projects, threadId).length > 0
    );
  })();

  // @ context picker inputs (HOY-220): the gitignore-aware path search for this
  // project, and the other threads offered under the Threads section.
  const searchPaths = useCallback(
    (query: string) =>
      projectPath ? listProjectPaths(projectPath, query, 50) : Promise.resolve([]),
    [projectPath],
  );
  const contextThreads = useMemo(
    () =>
      projects.flatMap((p) =>
        p.threads
          .filter((t) => t.id !== threadId)
          .map((t) => ({ threadId: t.id, title: t.title })),
      ),
    [projects, threadId],
  );

  const hasMessages = turns.length > 0;
  const shownError = threadError ?? error;

  // Vision gating for the attachment UI (HOY-205). Resolve the active ModelRef to
  // its full ModelInfo (which carries `input`); fail soft when unknown.
  const activeModelRef = threadModel ?? defaultModel;
  const activeModel = activeModelRef
    ? models.find(
        (m) =>
          m.provider === activeModelRef.provider && m.id === activeModelRef.id,
      ) ?? null
    : null;
  const canAttachImages = modelSupportsImages(activeModel);

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

  function handleSubmit(intent: "enter" | "shiftEnter") {
    const message = draft;
    const images = attachments.map((a) => a.content);
    // Behavior only applies mid-turn; submitPrompt ignores it when idle.
    const behavior = intent === "shiftEnter" ? "followUp" : "steer";
    setDraft(threadId, "");
    void submitPrompt(
      threadId,
      message,
      images.length > 0 ? images : undefined,
      behavior,
    );
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
      streaming={streaming}
      fill={!hasMessages || expanded}
      autoFocus={!hasMessages}
      expanded={expanded}
      onToggleExpand={hasMessages ? () => setExpanded((v) => !v) : undefined}
      focusSignal={focusSignal}
      widgets={widgetList}
      attachments={attachments}
      onAddFiles={(files) => void addAttachments(threadId, files)}
      onRemoveAttachment={(id) => removeAttachment(threadId, id)}
      canAttachImages={canAttachImages}
      searchPaths={searchPaths}
      threads={contextThreads}
      slashCommands={slashCommands}
      projectPath={projectPath}
    />
  );

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 px-1 py-0.5">
          <Sparkle
            className={cn(
              "size-4 shrink-0",
              threadIsAgent
                ? "text-agent"
                : active
                  ? "text-brand"
                  : "text-muted-foreground",
              // Breathe while this thread is generating so a working thread is
              // legible from the header even scrolled up, and background panels
              // that are still running stand out across the strip.
              streaming && "animate-pulse motion-reduce:animate-none",
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
                <Minus className="size-4" />
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
                    <span className="text-[11px] tabular-nums text-muted-foreground">
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
                  turn.origin === "subagentResult" ? (
                    <div
                      key={i}
                      className="rounded-md border border-agent/40 bg-agent/5 px-3 py-2 text-sm leading-relaxed text-muted-foreground"
                    >
                      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-agent">
                        Subagent result{turn.subagent ? ` -- ${turn.subagent.type}` : ""}
                      </div>
                      <div className="whitespace-pre-wrap">{turn.text}</div>
                    </div>
                  ) : (
                    <div
                      key={i}
                      className="rounded-md border border-border/60 bg-card/40 px-3 py-2 text-sm leading-relaxed text-foreground"
                    >
                      {turn.images && turn.images.length > 0 && (
                        <div className="mb-2 flex flex-wrap gap-2">
                          {turn.images.map((img, ii) => (
                            <img
                              key={ii}
                              src={`data:${img.mimeType};base64,${img.data}`}
                              alt="attachment"
                              className="size-20 rounded-md border border-border/60 object-cover"
                            />
                          ))}
                        </div>
                      )}
                      {turn.contexts && turn.contexts.length > 0 && (
                        <div className="mb-2 flex flex-wrap gap-1.5">
                          {turn.contexts.map((ref) => (
                            <TurnContextPill key={contextKey(ref)} contextRef={ref} />
                          ))}
                        </div>
                      )}
                      {turn.text && (
                        <div className="whitespace-pre-wrap">{turn.text}</div>
                      )}
                    </div>
                  )
                ) : (
                  <Message from="assistant" key={i} className="max-w-full">
                    <MessageContent className="w-full">
                      {turn.reasoning && (
                        <Reasoning
                          defaultOpen={expandReasoning}
                          autoCloseOnStreamEnd={!expandReasoning}
                          isStreaming={turn.reasoning.active ?? false}
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
                      {turn.streaming && !turn.aborted && (
                        <TurnStatus
                          blocks={turn.blocks}
                          reasoningActive={turn.reasoning?.active ?? false}
                          awaitingApproval={pendingPermissions.length > 0}
                        />
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

          {planReady !== undefined && (
            <PlanReadyCard
              onImplement={(mode) => void implementPlan(threadId, mode)}
              onDismiss={() => dismissPlanReady(threadId)}
            />
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

          <QueuedMessages queued={queued} streaming={streaming} />

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
  // HOY-253: an ask_question call rides the select path with its payload smuggled
  // in the title. Render the structured questionnaire instead of flat buttons.
  const askPayload =
    request.method === "select" ? parseAskPayload(request.title) : null;
  if (askPayload) {
    return <QuestionnaireCard payload={askPayload} onAnswer={onAnswer} />;
  }
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

// HOY-253: structured questionnaire for the ask_question tool. Rides the same
// blocking select path as ApprovalCard, but renders each question's header chip,
// radio (single) or checkbox (multi) options with trade-off text, a recommended
// marker, an optional preview stacked under the selected option, and a free-form
// "Other" row on single-select. Multiple questions are shown one at a time as a
// stepper (Back / Next / Submit with a progress indicator) rather than stacked,
// so the card stays compact and focused. Answers serialize to JSON in the select
// `value`; the sidecar parses them back into structured answers. Cancel declines
// the whole dialog, which the sidecar degrades to a cancelled result.
const ASK_OTHER = " other";

function orderedOptions(q: AskQuestion) {
  if (!q.recommendedValue) return q.options;
  const rec = q.options.filter((o) => o.value === q.recommendedValue);
  const rest = q.options.filter((o) => o.value !== q.recommendedValue);
  return [...rec, ...rest];
}

function OptionMark({ multi, selected }: { multi: boolean; selected: boolean }) {
  if (multi) {
    return selected ? (
      <Check className="mt-0.5 size-3.5 shrink-0 text-brand" />
    ) : (
      <Square className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
    );
  }
  return selected ? (
    <CircleDot className="mt-0.5 size-3.5 shrink-0 text-brand" />
  ) : (
    <Circle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
  );
}

function QuestionnaireCard({
  payload,
  onAnswer,
}: {
  payload: AskPayload;
  onAnswer: (answer: { value?: string; cancelled?: boolean }) => void;
}) {
  // One question at a time (stepper). single-select: one chosen value per
  // question id (may be ASK_OTHER). multi-select: the chosen values per id.
  const [step, setStep] = useState(0);
  const [single, setSingle] = useState<Record<string, string>>({});
  const [multi, setMulti] = useState<Record<string, string[]>>({});
  const [otherText, setOtherText] = useState<Record<string, string>>({});

  const isAnswered = (q: AskQuestion): boolean => {
    if (q.multiSelect) return (multi[q.id]?.length ?? 0) > 0;
    const sel = single[q.id];
    if (!sel) return false;
    if (sel === ASK_OTHER) return (otherText[q.id]?.trim().length ?? 0) > 0;
    return true;
  };

  const total = payload.questions.length;
  const q = payload.questions[step];
  const isLast = step === total - 1;
  const currentAnswered = isAnswered(q);
  const allAnswered = payload.questions.every(isAnswered);

  const toggleMulti = (qid: string, value: string) =>
    setMulti((prev) => {
      const cur = new Set(prev[qid] ?? []);
      if (cur.has(value)) cur.delete(value);
      else cur.add(value);
      return { ...prev, [qid]: [...cur] };
    });

  const submit = () => {
    const answers: AskAnswer[] = payload.questions.map((qq) => {
      if (qq.multiSelect) {
        const values = multi[qq.id] ?? [];
        const labels = values.map((v) => qq.options.find((o) => o.value === v)?.label ?? v);
        return { questionId: qq.id, kind: "multi", selectedValues: values, selectedLabels: labels };
      }
      const sel = single[qq.id];
      if (sel === ASK_OTHER) {
        return { questionId: qq.id, kind: "custom", selectedValues: [], selectedLabels: [], text: otherText[qq.id]?.trim() ?? "" };
      }
      const opt = qq.options.find((o) => o.value === sel);
      return {
        questionId: qq.id,
        kind: "option",
        selectedValues: opt ? [opt.value] : [],
        selectedLabels: opt ? [opt.label] : [],
      };
    });
    onAnswer({ value: JSON.stringify({ answers }) });
  };

  return (
    <div className="mx-3 mb-2 flex max-h-[70vh] shrink-0 flex-col rounded-lg border border-brand/40 bg-card/70 px-3 py-2.5">
      <div className="flex min-h-0 items-start gap-2.5 overflow-y-auto">
        <ShieldQuestion className="mt-0.5 size-4 shrink-0 text-brand" />
        <div className="min-w-0 flex-1 space-y-2">
          {total > 1 && (
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1">
                {payload.questions.map((qq, i) => (
                  <span
                    key={qq.id}
                    className={cn(
                      "h-1.5 rounded-full transition-all",
                      i === step ? "w-4 bg-brand" : isAnswered(qq) ? "w-1.5 bg-brand/60" : "w-1.5 bg-border",
                    )}
                  />
                ))}
              </div>
              <span className="text-[10px] text-muted-foreground">
                {step + 1} of {total}
              </span>
            </div>
          )}
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              {q.header && (
                <Badge variant="outline" className="text-[10px]">
                  {q.header}
                </Badge>
              )}
              <span className="text-xs font-medium text-foreground">{q.question}</span>
            </div>
            <div className="space-y-1">
              {orderedOptions(q).map((o) => {
                const selected = q.multiSelect
                  ? (multi[q.id]?.includes(o.value) ?? false)
                  : single[q.id] === o.value;
                return (
                  <div key={o.value}>
                    <button
                      type="button"
                      onClick={() =>
                        q.multiSelect
                          ? toggleMulti(q.id, o.value)
                          : setSingle((p) => ({ ...p, [q.id]: o.value }))
                      }
                      className={cn(
                        "flex w-full items-start gap-2 rounded-md border px-2 py-1.5 text-left transition-colors",
                        selected ? "border-brand/60 bg-brand/5" : "border-border hover:border-brand/40",
                      )}
                    >
                      <OptionMark multi={q.multiSelect} selected={selected} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-xs text-foreground">{o.label}</span>
                          {o.value === q.recommendedValue && (
                            <Badge variant="outline" className="border-brand/40 text-[9px] text-brand">
                              Recommended
                            </Badge>
                          )}
                        </div>
                        {o.description && <p className="text-[11px] text-muted-foreground">{o.description}</p>}
                      </div>
                    </button>
                    {selected && o.preview && (
                      <pre className="mt-1 ml-6 overflow-x-auto whitespace-pre rounded-md border border-border bg-muted/40 px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
                        {o.preview}
                      </pre>
                    )}
                  </div>
                );
              })}
              {!q.multiSelect && (
                <div>
                  <button
                    type="button"
                    onClick={() => setSingle((p) => ({ ...p, [q.id]: ASK_OTHER }))}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left transition-colors",
                      single[q.id] === ASK_OTHER ? "border-brand/60 bg-brand/5" : "border-border hover:border-brand/40",
                    )}
                  >
                    <OptionMark multi={false} selected={single[q.id] === ASK_OTHER} />
                    <span className="text-xs text-muted-foreground">Other</span>
                  </button>
                  {single[q.id] === ASK_OTHER && (
                    <Input
                      autoFocus
                      value={otherText[q.id] ?? ""}
                      onChange={(e) => setOtherText((p) => ({ ...p, [q.id]: e.target.value }))}
                      placeholder="Type your answer"
                      className="mt-1 ml-6 h-7 text-xs"
                    />
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      <div className="mt-3 flex shrink-0 items-center justify-between gap-1.5">
        <Button
          variant="ghost"
          size="sm"
          disabled={step === 0}
          className="h-7 text-xs text-muted-foreground disabled:opacity-40"
          onClick={() => setStep((s) => Math.max(0, s - 1))}
        >
          Back
        </Button>
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-muted-foreground hover:text-destructive"
            onClick={() => onAnswer({ cancelled: true })}
          >
            Cancel
          </Button>
          {isLast ? (
            <Button
              variant="outline"
              size="sm"
              disabled={!allAnswered}
              className="h-7 border-brand/40 text-xs text-brand hover:text-brand"
              onClick={submit}
            >
              Submit
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={!currentAnswered}
              className="h-7 border-brand/40 text-xs text-brand hover:text-brand"
              onClick={() => setStep((s) => Math.min(total - 1, s + 1))}
            >
              Next
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// Plan-mode handoff card (HOY-213). Shown when a plan-mode turn produced a
// proposed_plan block. The two Implement actions pick the execute mode to land
// in (default reviews each edit; acceptEdits auto-approves file edits), so the
// user chooses oversight at approval time. Keep planning dismisses and stays in
// plan mode. The plan stays in the transcript either way.
function PlanReadyCard({
  onImplement,
  onDismiss,
}: {
  onImplement: (mode: PermissionMode) => void;
  onDismiss: () => void;
}) {
  return (
    <div className="mx-3 mb-2 shrink-0 rounded-lg border border-agent/40 bg-card/70 px-3 py-2.5">
      <div className="flex items-start gap-2.5">
        <ClipboardCheck className="mt-0.5 size-4 shrink-0 text-agent" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium leading-relaxed text-foreground">
            Plan ready
          </div>
          <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Approve to leave plan mode and start implementing, or keep planning to
            refine it first.
          </div>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-end gap-1.5">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs text-muted-foreground"
          onClick={onDismiss}
        >
          Keep planning
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 border-agent/40 text-xs text-agent hover:text-agent"
          onClick={() => onImplement("default")}
        >
          Implement (review each edit)
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 border-agent/40 text-xs text-agent hover:text-agent"
          onClick={() => onImplement("acceptEdits")}
        >
          Implement (auto-approve edits)
        </Button>
      </div>
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
// Read-only chips for Pi's steering/follow-up queues (HOY-218). They clear when
// Pi delivers the message (a queueUpdate drops it). Abort does not clear Pi's
// queue, so when idle with messages still queued we note they will be delivered
// on the next turn. There is no cancel affordance: Pi has no clear-queue RPC.
function QueuedMessages({
  queued,
  streaming,
}: {
  queued: { steering: string[]; followUp: string[] };
  streaming: boolean;
}) {
  const chips = [
    ...queued.steering.map((text) => ({ kind: "steer" as const, text })),
    ...queued.followUp.map((text) => ({ kind: "followUp" as const, text })),
  ];
  if (chips.length === 0) return null;

  return (
    <div className="mx-3 mb-2 space-y-1.5">
      <div className="flex flex-wrap gap-1.5">
        {chips.map((chip, i) => (
          <span
            key={i}
            className={cn(
              "inline-flex max-w-full items-center rounded-full border px-2.5 py-1 text-xs",
              chip.kind === "steer"
                ? "border-brand/40 bg-brand/10 text-brand"
                : "border-border/60 bg-muted/40 text-muted-foreground",
            )}
          >
            <span className="truncate">{chip.text}</span>
          </span>
        ))}
      </div>
      {!streaming && (
        <p className="text-xs text-muted-foreground">
          Queued messages will be delivered on your next turn.
        </p>
      )}
    </div>
  );
}

// Read-only @ context marker on a sent user turn (HOY-220). Mirrors the composer
// pill without a remove affordance.
function TurnContextPill({ contextRef }: { contextRef: ContextRef }) {
  const Icon =
    contextRef.kind === "thread"
      ? MessageSquare
      : contextRef.kind === "directory"
        ? Folder
        : FileIcon;
  const label = contextRef.kind === "thread" ? contextRef.title : contextRef.name;
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 text-xs text-muted-foreground">
      <Icon className="size-3 shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  );
}

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

// HOY-258: a persistent "the model is working" line pinned to the bottom of the
// streaming turn, so a long tool call no longer looks idle after the first block
// lands. It surfaces *what* is happening rather than a bare spinner, and yields
// to the other honest-state affordances so it never becomes a second competing
// signal:
//   - a tool awaiting approval -> silent (the model is blocked on the user, not
//     working; the approval card carries that state). The authority is the
//     thread's pending-permission queue, not the tool block's own flag: Pi emits
//     the tool `start` (running) before the approval gate, so the block reads as
//     running while the user is actually the one being waited on.
//   - only thinking -> silent (the reasoning block already shimmers "Thinking");
//   - a tool running -> "Running <tool>"; otherwise the generic "Working".
// Matches the original pulsing-dot style and honors reduced motion.
function TurnStatus({
  blocks,
  reasoningActive,
  awaitingApproval,
}: {
  blocks: AssistantBlock[];
  reasoningActive: boolean;
  awaitingApproval: boolean;
}) {
  if (awaitingApproval) return null;
  if (blocks.some((b) => b.kind === "tool" && b.tool.pending)) return null;

  let runningTool: ToolUI | undefined;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.kind === "tool" && b.tool.running) {
      runningTool = b.tool;
      break;
    }
  }

  if (!runningTool && reasoningActive) return null;

  const label = runningTool ? `Running ${runningTool.name}` : "Working";

  return (
    <div className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
      <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-brand motion-reduce:animate-none" />
      <span className="truncate">{label}…</span>
    </div>
  );
}

// Zed splits tool calls by kind: edit and execute render as bordered cards
// (diff / command + output), everything else is a bare muted row whose output
// shows on expand.
function ToolCall({ tool }: { tool: ToolUI }) {
  const kind = toolKind(tool.name);
  const expandToolDetails = usePrefsStore((s) => s.expandToolDetails);
  // Each tool renders as a bordered card. Collapsed by default (HOY-251) to a
  // header row; the user clicks it to reveal the body (diff, command + output,
  // or result). Expanded when the pref is on, or when the tool needs attention:
  // an approval-pending tool shows a diff the user must see to approve, and an
  // errored tool surfaces its failure without a hunt.
  const defaultOpen = expandToolDetails || tool.pending || tool.isError;
  // The terminal body already shows the command ($ ...), so the header stays a
  // generic tool label (lowercase, like the other tools) instead of repeating it.
  const headerTitle = kind === "terminal" ? tool.name : tool.title;

  return (
    <Tool
      defaultOpen={defaultOpen}
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
