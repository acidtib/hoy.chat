import { useMemo, useState } from "react";
import { Activity, AlertCircle, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import { Composer } from "@/components/Composer";
import { useSessionStore } from "@/state/store";
import type { ModelInfo, PiState } from "@/lib/types";
import { MOCK_TURNS } from "@/lib/mock-conversation";

export function ThreadView({
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
  const activeThreadId = useSessionStore((s) => s.activeThreadId);
  const [draft, setDraft] = useState("");

  const { title, projectName } = useMemo(() => {
    for (const p of projects) {
      const t = p.threads.find((thread) => thread.id === activeThreadId);
      if (t) return { title: t.title, projectName: p.name };
    }
    return { title: "New thread", projectName: null as string | null };
  }, [projects, activeThreadId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border bg-background/60 px-4 backdrop-blur-sm">
        <span className="min-w-0 truncate text-sm font-medium text-foreground">
          {title}
        </span>
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                onClick={onDebug}
                disabled={busy}
                aria-label="Debug get_state"
              >
                <Activity className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {busy ? "Calling get_state..." : "Debug: get_state"}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                onClick={onOpenSettings}
                aria-label="Settings"
              >
                <Settings className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Settings</TooltipContent>
          </Tooltip>
        </div>
      </header>

      <Conversation>
        <ConversationContent className="mx-auto w-full max-w-5xl px-10">
          {error && (
            <div className="flex items-start gap-2.5 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <span className="leading-relaxed">{error}</span>
            </div>
          )}

          {debug && (
            <div className="rounded-xl border border-border bg-card/60">
              <div className="flex items-center justify-between gap-2 px-4 py-3 text-xs font-medium text-muted-foreground">
                <span className="flex items-center gap-2 uppercase tracking-wider">
                  <span className="size-1.5 rounded-full bg-brand" aria-hidden />
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

          {MOCK_TURNS.map((turn, i) =>
            turn.role === "user" ? (
              <Message from="user" key={i}>
                <MessageContent>{turn.text}</MessageContent>
              </Message>
            ) : (
              <Message from="assistant" key={i} className="max-w-full">
                <MessageContent className="w-full">
                  {turn.reasoning && (
                    <Reasoning defaultOpen={false} duration={turn.reasoning.seconds}>
                      <ReasoningTrigger />
                      <ReasoningContent>{turn.reasoning.text}</ReasoningContent>
                    </Reasoning>
                  )}
                  {turn.tools?.map((tool, j) => (
                    <Tool className="group" key={j}>
                      <ToolHeader
                        title={tool.title}
                        type={`tool-${tool.name}`}
                        state="output-available"
                      />
                      <ToolContent>
                        <ToolInput input={tool.input} />
                        <ToolOutput output={tool.output} errorText={undefined} />
                      </ToolContent>
                    </Tool>
                  ))}
                  {turn.text && <MessageResponse>{turn.text}</MessageResponse>}
                </MessageContent>
              </Message>
            ),
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="shrink-0 bg-background/60 pb-2 pt-2 backdrop-blur-sm">
        <div className="mx-auto w-full max-w-5xl px-10">
          <Composer
            value={draft}
            onChange={setDraft}
            models={models}
            currentModel={currentModel}
            selecting={selecting}
            onSelectModel={onSelectModel}
            projectName={projectName}
            showContext={false}
            placeholder="Reply to Pi..."
          />
        </div>
      </div>
    </div>
  );
}
