import { useMemo, useState } from "react";
import {
  Activity,
  AlertCircle,
  ChevronDown,
  FilePen,
  Maximize2,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  Sparkle,
  Terminal,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
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
import { cn } from "@/lib/utils";
import { useSessionStore } from "@/state/store";
import type { ModelInfo, PiState, ToolUI, Turn } from "@/lib/types";

// Stable empty reference so the turns selector doesn't return a fresh [] each
// render (which would loop zustand's snapshot equality check).
const EMPTY_TURNS: Turn[] = [];

export function ThreadView({
  threadId,
  active,
  onClose,
  models,
  currentModel,
  selecting,
  onSelectModel,
  onOpenSettings,
  onDebug,
  busy,
  debug,
  error,
}: {
  threadId: string;
  active: boolean;
  onClose: () => void;
  models: ModelInfo[];
  currentModel?: ModelInfo | null;
  selecting: boolean;
  onSelectModel: (provider: string, modelId: string) => void;
  onOpenSettings: () => void;
  onDebug: () => void;
  busy: boolean;
  debug: PiState | null;
  error: string | null;
}) {
  const projects = useSessionStore((s) => s.projects);
  const addThread = useSessionStore((s) => s.addThread);
  const turns = useSessionStore((s) => s.turns[threadId] ?? EMPTY_TURNS);
  const streaming = useSessionStore((s) => s.streaming[threadId] ?? false);
  const threadError = useSessionStore((s) => s.threadErrors[threadId] ?? null);
  const submitPrompt = useSessionStore((s) => s.submitPrompt);
  const [draft, setDraft] = useState("");

  const { title, projectId } = useMemo(() => {
    for (const p of projects) {
      const t = p.threads.find((thread) => thread.id === threadId);
      if (t) return { title: t.title, projectId: p.id };
    }
    return { title: "New thread", projectId: null as string | null };
  }, [projects, threadId]);

  const hasMessages = turns.length > 0;
  const shownError = threadError ?? error;

  function handleSubmit() {
    const message = draft;
    setDraft("");
    void submitPrompt(threadId, message);
  }

  const composer = (
    <Composer
      value={draft}
      onChange={setDraft}
      onSubmit={handleSubmit}
      models={models}
      currentModel={currentModel}
      selecting={selecting}
      onSelectModel={onSelectModel}
      fill={!hasMessages}
      autoFocus={!hasMessages}
      disabled={streaming}
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <button
          type="button"
          className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1 py-0.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          <Sparkle
            className={cn(
              "size-4 shrink-0",
              active ? "text-brand" : "text-muted-foreground",
            )}
          />
          <span className="truncate text-sm font-medium text-foreground">
            {title}
          </span>
          <ChevronDown className="size-3.5 shrink-0" />
        </button>

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
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            aria-label="Expand"
          >
            <Maximize2 className="size-3.5" />
          </Button>
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
              <DropdownMenuItem onSelect={onOpenSettings}>
                <Settings className="size-4" />
                Settings
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onDebug} disabled={busy}>
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
                    className="rounded-md border border-border/60 bg-card/40 px-3 py-2 text-sm leading-relaxed text-foreground"
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
                      {turn.tools.map((tool) => (
                        <ToolCall tool={tool} key={tool.id} />
                      ))}
                      {turn.text && (
                        <MessageResponse>{turn.text}</MessageResponse>
                      )}
                      {turn.streaming &&
                        !turn.text &&
                        turn.tools.length === 0 && (
                          <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                            <span className="size-1.5 animate-pulse rounded-full bg-brand" />
                            Working...
                          </span>
                        )}
                    </MessageContent>
                  </Message>
                ),
              )}
            </ConversationContent>
            <ConversationScrollButton />
          </Conversation>

          <div className="shrink-0 border-t border-border">{composer}</div>
        </>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col px-3 pb-2 pt-1">
          {composer}
        </div>
      )}
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
  const card = kind === "edit" || kind === "terminal";

  return (
    <Tool
      defaultOpen={card}
      className={cn(
        "group",
        card
          ? "my-0.5 overflow-hidden rounded-md border border-border/70"
          : "",
      )}
    >
      <ToolHeader
        title={tool.title}
        type={`tool-${tool.name}`}
        state={
          tool.running
            ? "input-available"
            : tool.isError
              ? "output-error"
              : "output-available"
        }
        icon={toolIcon(kind)}
        className={cn(card && "bg-muted/25 px-2 py-1.5 text-foreground")}
      />
      <ToolContent
        className={cn(
          card
            ? "border-t border-border/70"
            : "ml-[7px] border-l border-border/60",
        )}
      >
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
          <pre className="scrollbar-thin overflow-x-auto whitespace-pre-wrap py-1.5 pl-4 font-mono text-xs leading-relaxed text-muted-foreground">
            {tool.output}
          </pre>
        )}
      </ToolContent>
    </Tool>
  );
}
