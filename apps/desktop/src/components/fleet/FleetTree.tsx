import { useMemo, useState } from "react";
import { Sparkle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn, formatTokens } from "@/lib/utils";
import { useSessionStore } from "@/state/store";
import { fleetMembers, fleetStatus, currentTool, type FleetStatus } from "@/state/fleet";
import { MAX_SUBAGENT_DEPTH } from "@/state/limits";
import type { Thread } from "@/lib/types";

// Depth-based indentation, generalizing Sidebar.tsx's ThreadRow convention
// (pl-3 at depth 0, pl-9 at depth 1) by the same +24px-per-level step. Written
// as literal class strings (not built from a template) so Tailwind's scanner
// can see them; MAX_SUBAGENT_DEPTH caps real depth at 3, so five entries cover
// every reachable fleet with room to spare. The assertion below fails loudly
// (rather than silently flattening indentation) if that cap is ever raised
// past what this table covers.
const DEPTH_PADDING = ["pl-3", "pl-9", "pl-[60px]", "pl-[84px]", "pl-[108px]"] as const;
if (MAX_SUBAGENT_DEPTH >= DEPTH_PADDING.length) {
  throw new Error(
    `FleetTree.DEPTH_PADDING has ${DEPTH_PADDING.length} entries but MAX_SUBAGENT_DEPTH is ${MAX_SUBAGENT_DEPTH}; add more entries.`,
  );
}
function depthPadding(depth: number): string {
  return DEPTH_PADDING[Math.min(depth, DEPTH_PADDING.length - 1)];
}

// Recursive fleet row renderer, shared by FleetRail (dense) and FleetBoard
// (dense=false). Walks the parent/children structure of one fleet's members
// only, not the whole workspace tree.
export function FleetTree({ rootId, dense }: { rootId: string; dense: boolean }) {
  const projects = useSessionStore((s) => s.projects);
  const streaming = useSessionStore((s) => s.streaming);
  const agentQueue = useSessionStore((s) => s.agentQueue);
  const stats = useSessionStore((s) => s.stats);
  const threadErrors = useSessionStore((s) => s.threadErrors);
  const turns = useSessionStore((s) => s.turns);
  const openThread = useSessionStore((s) => s.openThread);
  const setBodyView = useSessionStore((s) => s.setBodyView);
  const submitPrompt = useSessionStore((s) => s.submitPrompt);
  const stopStreaming = useSessionStore((s) => s.stopStreaming);
  const requestTeardown = useSessionStore((s) => s.requestTeardown);

  const members = useMemo(() => fleetMembers(projects, rootId), [projects, rootId]);

  const { byId, childrenMap } = useMemo(() => {
    const byId = new Map(members.map((t) => [t.id, t]));
    const childrenMap = new Map<string, Thread[]>();
    for (const t of members) {
      if (t.parentThreadId && byId.has(t.parentThreadId)) {
        const list = childrenMap.get(t.parentThreadId) ?? [];
        list.push(t);
        childrenMap.set(t.parentThreadId, list);
      }
    }
    return { byId, childrenMap };
  }, [members]);

  function handleOpen(id: string) {
    openThread(id);
    setBodyView("panels");
  }
  function handleStop(id: string) {
    void stopStreaming(id);
  }
  function handleCancel(id: string) {
    requestTeardown("archive", id);
  }
  function handleSteer(id: string, text: string) {
    void submitPrompt(id, text, undefined, "steer");
  }

  function renderNode(id: string, depth: number): React.ReactNode {
    const thread = byId.get(id);
    if (!thread) return null;
    const status = fleetStatus(id, streaming, agentQueue, threadErrors);
    const tool = dense ? null : currentTool(turns[id] ?? []);
    const tokens = stats[id]?.tokens.total ?? 0;
    const kids = childrenMap.get(id) ?? [];
    return (
      <div key={id}>
        <FleetRow
          thread={thread}
          depth={depth}
          dense={dense}
          status={status}
          tool={tool}
          tokens={tokens}
          onOpen={handleOpen}
          onStop={handleStop}
          onCancel={handleCancel}
          onSteer={handleSteer}
        />
        {kids.map((k) => renderNode(k.id, depth + 1))}
      </div>
    );
  }

  if (members.length === 0) return null;
  return <div className="flex flex-col gap-0.5">{renderNode(rootId, 0)}</div>;
}

function StatusDot({ status }: { status: FleetStatus }) {
  return (
    <span
      aria-hidden
      className={cn(
        "mt-1 size-2 shrink-0 rounded-full",
        status === "running" && "animate-pulse bg-agent",
        status === "queued" && "border border-muted-foreground bg-transparent",
        status === "done" && "bg-ok",
        status === "error" && "bg-destructive",
      )}
    />
  );
}

function FleetRow({
  thread,
  depth,
  dense,
  status,
  tool,
  tokens,
  onOpen,
  onStop,
  onCancel,
  onSteer,
}: {
  thread: Thread;
  depth: number;
  dense: boolean;
  status: FleetStatus;
  tool: string | null;
  tokens: number;
  onOpen: (id: string) => void;
  onStop: (id: string) => void;
  onCancel: (id: string) => void;
  onSteer: (id: string, text: string) => void;
}) {
  const [steering, setSteering] = useState(false);

  // A div, not a button: hover actions and (when steering) an inline input
  // nest inside the clickable row, matching Sidebar.tsx's ThreadRow.
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => {
        if (!steering) onOpen(thread.id);
      }}
      onKeyDown={(e) => {
        if (steering || e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(thread.id);
        }
      }}
      className={cn(
        "group flex w-full cursor-pointer items-start gap-2 py-1.5 pr-2 text-left text-sidebar-foreground transition-colors hover:bg-sidebar-accent/50",
        depthPadding(depth),
      )}
    >
      <StatusDot status={status} />
      <Sparkle className="mt-0.5 size-3.5 shrink-0 text-agent" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm leading-tight">{thread.title}</span>
      </span>

      {!dense && !steering && tool && (
        <span className="mt-0.5 shrink-0 truncate border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          {tool}
        </span>
      )}

      <span className="mt-0.5 shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
        {formatTokens(tokens)}
      </span>

      {!dense &&
        (steering ? (
          <SteerBox
            threadId={thread.id}
            onSteer={onSteer}
            onCollapse={() => setSteering(false)}
          />
        ) : (
          <ActionsRow
            status={status}
            threadId={thread.id}
            onOpen={onOpen}
            onStop={onStop}
            onCancel={onCancel}
            onSteerClick={() => setSteering(true)}
          />
        ))}
    </div>
  );
}

function ActionsRow({
  status,
  threadId,
  onOpen,
  onStop,
  onCancel,
  onSteerClick,
}: {
  status: FleetStatus;
  threadId: string;
  onOpen: (id: string) => void;
  onStop: (id: string) => void;
  onCancel: (id: string) => void;
  onSteerClick: () => void;
}) {
  return (
    <span className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
      {status === "running" && (
        <>
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              onOpen(threadId);
            }}
          >
            Open
          </Button>
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              onSteerClick();
            }}
          >
            Steer
          </Button>
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground hover:text-destructive"
            onClick={(e) => {
              e.stopPropagation();
              onStop(threadId);
            }}
          >
            Stop
          </Button>
        </>
      )}
      {status === "queued" && (
        <Button
          variant="ghost"
          size="xs"
          className="text-muted-foreground hover:text-destructive"
          onClick={(e) => {
            e.stopPropagation();
            onCancel(threadId);
          }}
        >
          Cancel
        </Button>
      )}
      {(status === "done" || status === "error") && (
        <Button
          variant="ghost"
          size="xs"
          className="text-muted-foreground hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation();
            onOpen(threadId);
          }}
        >
          Open
        </Button>
      )}
    </span>
  );
}

// Inline steer control: replaces the action row (not stacked below it) while
// active. Enter/the send button submit; Escape or a blur that isn't the send
// button collapses without sending. onMouseDown on the button keeps it from
// stealing focus (and firing the blur) before its click handler runs.
function SteerBox({
  threadId,
  onSteer,
  onCollapse,
}: {
  threadId: string;
  onSteer: (id: string, text: string) => void;
  onCollapse: () => void;
}) {
  const [value, setValue] = useState("");

  function send() {
    onSteer(threadId, value);
    setValue("");
    onCollapse();
  }

  return (
    <span className="flex shrink-0 items-center gap-1">
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onBlur={onCollapse}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            send();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCollapse();
          }
        }}
        placeholder="Steer this agent..."
        className="h-6 w-40 border border-border bg-background px-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none"
      />
      <Button
        variant="ghost"
        size="xs"
        className="text-muted-foreground hover:text-foreground"
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation();
          send();
        }}
      >
        Send
      </Button>
    </span>
  );
}
