import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Brain,
  CircleDot,
  Cpu,
  FoldVertical,
  GitBranch,
  ListTree,
  Maximize2,
  Split,
  SquareTerminal,
  Tag,
  User,
  Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  childDepth,
  FILTER_MODES,
  flattenTree,
  matchesFilter,
  nodeRoleLabel,
  toFlatNode,
  type FilterMode,
  type FlatNode,
} from "@/lib/treeNode";
import type { SessionTreeNode } from "@/lib/types";
import { findThread, useSessionStore } from "@/state/store";

// HOY-280: the `/tree` session-tree navigator. Lives in the ThreadView's right
// dock (a reusable sidebar host; see HOY-278 spike). Renders pi's pre-nested
// entry tree, keeps the linear common case a clean spine with a hover "Branch
// from here" hero, and lets branch points fan out with connectors. Filtering and
// keyboard nav run client-side over the fetched tree (HOY-279 slice).

const FILTER_LABEL: Record<FilterMode, string> = {
  default: "Default",
  "no-tools": "No tools",
  "user-only": "User",
  "labeled-only": "Labeled",
  all: "All",
};

export function TreeNavigator() {
  // The global dock follows the active thread panel (HOY-280): whichever panel
  // the user is interacting with, its tree shows here.
  const threadId = useSessionStore((s) => s.activeThreadId);
  const tree = useSessionStore((s) => (threadId ? s.sessionTree[threadId] : undefined));
  // The active thread's session id. A thread acquires its session lazily (on
  // hydrate or first prompt), so this goes null -> id after the thread becomes
  // active; the fetch effect keys on it so the tree loads once the session
  // exists, not just when the thread changes (HOY-280 stuck-loading fix).
  const sessionId = useSessionStore((s) =>
    threadId ? findThread(s.projects, threadId)?.thread.sessionId ?? null : null,
  );
  const closeRightDock = useSessionStore((s) => s.closeRightDock);
  const toggleFullScreen = useSessionStore((s) => s.toggleFullScreen);
  const refreshSessionTree = useSessionStore((s) => s.refreshSessionTree);
  const branchFromEntry = useSessionStore((s) => s.branchFromEntry);

  const [filter, setFilter] = useState<FilterMode>("default");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const onBranch = (entryId: string) => {
    if (threadId) branchFromEntry(threadId, entryId);
  };

  // The full flat order (pre-filter) backs both the visible rows and the scroll
  // fallback, which walks it to find a clicked meta node's nearest addressable
  // neighbor.
  const flatAll = useMemo<FlatNode[]>(
    () => (tree ? flattenTree(tree.tree, tree.leafId) : []),
    [tree],
  );

  // Scroll the active conversation panel to a clicked node and flash it (HOY-304).
  // Restored turns/blocks carry a data-entry-id (store.entryIdsFor); a meta or
  // tool-result node has none, so we fall back to the nearest addressable neighbor
  // in tree order rather than doing nothing.
  const scrollToEntry = useCallback(
    (entryId: string) => {
      if (!threadId) return;
      const panel = document.querySelector(
        `[data-thread-panel="${CSS.escape(threadId)}"]`,
      );
      if (!panel) return;
      const reduce =
        typeof window !== "undefined" &&
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      const at = (id: string) =>
        panel.querySelector(`[data-entry-id="${CSS.escape(id)}"]`);
      const reveal = (el: Element) => {
        el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
        // A brand wash that fades out. Driven by the Web Animations API, not a CSS
        // class: React owns className on these turns and reconciles an imperatively
        // added class away on the next render, but a WAAPI animation is untouched.
        if (reduce) return;
        const brand =
          getComputedStyle(document.documentElement).getPropertyValue("--brand").trim() ||
          "oklch(0.62 0.17 274)";
        (el as HTMLElement).animate(
          [
            { backgroundColor: `color-mix(in oklch, ${brand} 32%, transparent)` },
            { backgroundColor: "transparent" },
          ],
          { duration: 1100, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
        );
      };
      const direct = at(entryId);
      if (direct) return reveal(direct);
      // No visible turn for this entry: search outward (back first, then forward)
      // for the closest node that does render.
      const order = flatAll.map((n) => n.id);
      const idx = order.indexOf(entryId);
      if (idx === -1) return;
      for (let d = 1; d < order.length; d++) {
        const back = idx - d >= 0 ? at(order[idx - d]) : null;
        if (back) return reveal(back);
        const fwd = idx + d < order.length ? at(order[idx + d]) : null;
        if (fwd) return reveal(fwd);
      }
    },
    [threadId, flatAll],
  );

  // Click a row: select it AND scroll the transcript to it. Keyboard navigation
  // (moveSelection) only moves the tree's own selection, so arrowing through the
  // list never yanks the transcript around.
  const handleSelect = useCallback(
    (id: string) => {
      setSelectedId(id);
      scrollToEntry(id);
    },
    [scrollToEntry],
  );

  // Prime on open, whenever the active thread changes, and once that thread
  // acquires its session (sessionId in the deps). Without the sessionId key, a
  // thread selected before its session exists would call refreshSessionTree with
  // no session, get a no-op, and stay stuck on "Loading" until the dock is
  // reopened. The store also keeps it fresh on turn done while the dock is open.
  useEffect(() => {
    if (threadId && sessionId) void refreshSessionTree(threadId);
  }, [threadId, sessionId, refreshSessionTree]);

  // Move focus into the rail on open so arrow keys / Esc work without a click
  // (the spike's focus model). Runs once per mount.
  useEffect(() => {
    listRef.current?.focus();
  }, []);

  // The visible, ordered rows drive keyboard navigation; the recursive renderer
  // below reproduces the same order and filter.
  const visible = useMemo<FlatNode[]>(
    () => flatAll.filter((n) => matchesFilter(n, filter)),
    [flatAll, filter],
  );

  // Default the selection to the active leaf so a fresh open lands where you are.
  useEffect(() => {
    if (selectedId && visible.some((n) => n.id === selectedId)) return;
    const active = visible.find((n) => n.isActive) ?? visible[visible.length - 1];
    setSelectedId(active?.id ?? null);
  }, [visible, selectedId]);

  function moveSelection(delta: number) {
    if (visible.length === 0) return;
    const idx = visible.findIndex((n) => n.id === selectedId);
    const next = idx === -1 ? 0 : Math.min(visible.length - 1, Math.max(0, idx + delta));
    const node = visible[next];
    setSelectedId(node.id);
    listRef.current
      ?.querySelector(`[data-entry="${CSS.escape(node.id)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveSelection(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveSelection(-1);
    } else if (e.key === "Home") {
      e.preventDefault();
      if (visible[0]) setSelectedId(visible[0].id);
    } else if (e.key === "End") {
      e.preventDefault();
      if (visible.length) setSelectedId(visible[visible.length - 1].id);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (selectedId) onBranch(selectedId);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeRightDock();
    }
  }

  const leafId = tree?.leafId ?? null;

  return (
    <aside
      className="flex w-[340px] shrink-0 flex-col border-l border-border bg-sidebar"
      aria-label="Tree navigator"
    >
      <div className="shrink-0 border-b border-border px-3 pb-2 pt-2.5">
        <div className="flex items-center gap-2">
          <ListTree className="size-4 shrink-0 text-brand" />
          <span className="text-[13px] font-semibold">Tree</span>
          <div className="ml-auto flex items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground"
                  onClick={() => threadId && toggleFullScreen(threadId)}
                  disabled={!threadId}
                  aria-label="Expand thread"
                >
                  <Maximize2 className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Expand thread</TooltipContent>
            </Tooltip>
          </div>
        </div>
        <p className="mt-1.5 text-[11.5px] leading-snug text-muted-foreground">
          <span className="text-foreground">Branch a new line of thought</span> from any point.
        </p>
        <div
          role="radiogroup"
          aria-label="Filter entries"
          className="mt-2 flex border border-border"
        >
          {FILTER_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={filter === mode}
              onClick={() => setFilter(mode)}
              className={cn(
                "flex-1 cursor-pointer border-r border-border px-1 py-1 text-center font-mono text-[10.5px] leading-none text-muted-foreground transition-colors last:border-r-0 hover:bg-accent hover:text-foreground",
                filter === mode && "bg-brand/15 text-brand hover:bg-brand/15 hover:text-brand",
              )}
            >
              {FILTER_LABEL[mode]}
            </button>
          ))}
        </div>
      </div>

      <div
        ref={listRef}
        role="tree"
        aria-label="Session entries"
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5 focus:outline-none focus-visible:ring-1 focus-visible:ring-brand/50"
      >
        {!threadId ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            Open a thread to see its tree.
          </p>
        ) : !sessionId ? (
          // No session yet (a fresh thread before its first message): there is
          // nothing to load, so say so rather than sit on "Loading" forever.
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            Send a message to start this thread's tree.
          </p>
        ) : !tree ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            Loading the session tree...
          </p>
        ) : visible.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            No entries match this filter.
          </p>
        ) : (
          <TreeRows
            nodes={tree.tree}
            depth={0}
            leafId={leafId}
            filter={filter}
            selectedId={selectedId}
            onSelect={handleSelect}
            onBranch={onBranch}
          />
        )}
      </div>
    </aside>
  );
}

// Recursive renderer over pi's pre-nested children. Linear runs stay a flat
// spine; a branch point wraps each divergent child in a connector column.
function TreeRows({
  nodes,
  depth,
  leafId,
  filter,
  selectedId,
  onSelect,
  onBranch,
}: {
  nodes: SessionTreeNode[];
  depth: number;
  leafId: string | null;
  filter: FilterMode;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onBranch: (id: string) => void;
}) {
  return (
    <>
      {nodes.map((node) => {
        const flat = toFlatNode(node, depth, leafId);
        const branching = node.children.length > 1;
        const kids =
          node.children.length === 0 ? null : branching ? (
            node.children.map((child) => (
              <div
                key={child.entry.id}
                className="relative ml-3 border-l border-border/80 pl-3 before:absolute before:-top-2 before:left-[-1px] before:h-5 before:w-3 before:rounded-bl-[2px] before:border-b before:border-l before:border-border/80 before:content-['']"
              >
                <TreeRows
                  nodes={[child]}
                  depth={depth + 1}
                  leafId={leafId}
                  filter={filter}
                  selectedId={selectedId}
                  onSelect={onSelect}
                  onBranch={onBranch}
                />
              </div>
            ))
          ) : (
            <TreeRows
              nodes={node.children}
              depth={childDepth(node, depth)}
              leafId={leafId}
              filter={filter}
              selectedId={selectedId}
              onSelect={onSelect}
              onBranch={onBranch}
            />
          );
        return (
          <Fragment key={flat.id}>
            {matchesFilter(flat, filter) && (
              <TreeRow
                node={flat}
                selected={flat.id === selectedId}
                filter={filter}
                onSelect={onSelect}
                onBranch={onBranch}
              />
            )}
            {kids}
          </Fragment>
        );
      })}
    </>
  );
}

function isToolOnly(node: FlatNode): boolean {
  const m = node.message;
  return Boolean(m?.hasToolCall && m.toolNames.join(", ") === m.preview);
}

function nodeIcon(node: FlatNode) {
  if (node.entry.type === "message") {
    switch (node.message?.role) {
      case "user":
        return User;
      case "assistant":
        return isToolOnly(node) ? Wrench : Bot;
      case "toolResult":
        return Wrench;
      case "bashExecution":
        return SquareTerminal;
      default:
        return CircleDot;
    }
  }
  switch (node.entry.type) {
    case "compaction":
      return FoldVertical;
    case "model_change":
      return Cpu;
    case "thinking_level_change":
      return Brain;
    case "branch_summary":
      return GitBranch;
    case "label":
      return Tag;
    default:
      return CircleDot;
  }
}

function TreeRow({
  node,
  selected,
  filter,
  onSelect,
  onBranch,
}: {
  node: FlatNode;
  selected: boolean;
  filter: FilterMode;
  onSelect: (id: string) => void;
  onBranch: (id: string) => void;
}) {
  const Icon = nodeIcon(node);
  const isMessage = node.entry.type === "message";
  const preview =
    node.message?.preview ||
    (node.entry.type === "compaction"
      ? `Compacted context`
      : node.entry.type === "model_change"
        ? node.entry.modelId
        : node.entry.type === "session_info"
          ? "Session start"
          : nodeRoleLabel(node));
  // A "+tools" hint only on a mixed step (prose that also ran tools); a tool-only
  // step already reads as tools via its wrench icon and tool-name preview.
  const showToolChip =
    isMessage &&
    node.message?.hasToolCall &&
    !isToolOnly(node) &&
    filter !== "no-tools";

  return (
    <div
      role="treeitem"
      aria-selected={selected}
      aria-current={node.isActive ? "true" : undefined}
      tabIndex={-1}
      onClick={() => onSelect(node.id)}
      data-entry={node.id}
      className={cn(
        "group relative flex cursor-pointer items-start gap-2 px-2 py-1 text-left transition-colors",
        selected ? "bg-accent" : "hover:bg-accent/50",
        node.isActive && "bg-brand/12",
      )}
    >
      {node.isActive && (
        <span aria-hidden className="absolute inset-y-1 left-0 w-0.5 bg-brand" />
      )}
      <Icon
        className={cn(
          "mt-0.5 size-3.5 shrink-0",
          node.isActive ? "text-brand" : "text-muted-foreground",
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="shrink-0 font-mono text-[9.5px] uppercase tracking-wide text-muted-foreground">
            {nodeRoleLabel(node)}
          </span>
          {node.label && (
            <span className="shrink-0 border border-border px-1 py-px font-mono text-[9.5px] text-foreground">
              {node.label}
            </span>
          )}
          {showToolChip && (
            <span className="shrink-0 font-mono text-[9.5px] text-muted-foreground">
              +tools
            </span>
          )}
          {node.isActive && (
            <span className="shrink-0 border border-brand/45 px-1 py-px font-mono text-[9px] uppercase tracking-wide text-brand">
              active
            </span>
          )}
        </span>
        <span
          className={cn(
            "mt-0.5 block truncate text-[12px]",
            isMessage ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {preview || "—"}
        </span>
      </span>
      {isMessage && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onBranch(node.id);
          }}
          title="Branch to a new thread from here"
          aria-label="Branch from here"
          className="mt-0.5 flex shrink-0 items-center gap-1 border border-brand/40 bg-brand/10 px-1.5 py-0.5 font-mono text-[10px] text-brand opacity-0 transition-opacity hover:bg-brand/20 focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Split className="size-3" />
          Branch
        </button>
      )}
    </div>
  );
}
