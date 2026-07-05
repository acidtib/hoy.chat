// Pure helpers for the /tree navigator (HOY-280): peek pi's opaque message
// payload for a node preview, flatten the pre-nested tree for rendering +
// keyboard nav, and decide filter visibility. Kept free of React/store so it is
// unit-testable in isolation.
import type { SessionEntry, SessionTreeNode } from "@/lib/types";

// A loose view of pi's normalized message (mirrors turns.ts's RawMessage). A
// `message` entry types its payload as `unknown` over get_tree; we read only the
// fields a node preview needs. Pi owns the canonical schema.
type RawPart = { type?: string; text?: string; name?: string };
type RawMessage = {
  role?: string;
  content?: string | RawPart[];
  command?: string; // bashExecution
  summary?: string; // branchSummary / compactionSummary
};

// pi message roles seen in a session (see the pi-ai Message union + pi's custom
// message variants): user / assistant / toolResult, plus the non-LLM roles.
export type NodeRole =
  | "user"
  | "assistant"
  | "toolResult"
  | "bashExecution"
  | "custom"
  | "branchSummary"
  | "compactionSummary"
  | "unknown";

export interface MessageFacet {
  role: NodeRole;
  preview: string;
  hasToolCall: boolean;
  // Tool-call names on an assistant message (empty otherwise), so a tool-only
  // step can preview what it ran instead of a bare role label.
  toolNames: string[];
}

const KNOWN_ROLES: ReadonlySet<string> = new Set<NodeRole>([
  "user",
  "assistant",
  "toolResult",
  "bashExecution",
  "custom",
  "branchSummary",
  "compactionSummary",
]);

// Collapse pi's `string | parts[]` content to its text, joining `type:"text"`
// blocks (same rule as turns.ts contentText).
function contentText(content: RawMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
}

function firstLine(text: string): string {
  const trimmed = text.trim();
  const nl = trimmed.indexOf("\n");
  return nl === -1 ? trimmed : trimmed.slice(0, nl);
}

// Read role, a one-line preview, and whether the message carries tool calls out
// of pi's opaque message payload. Tool CALLS are `type:"toolCall"` content blocks
// on an assistant message (there is no separate toolCalls field / role); a tool
// RESULT is its own `role:"toolResult"` message, not a tool call.
export function messageFacet(message: unknown): MessageFacet {
  const m = (message ?? {}) as RawMessage;
  const role: NodeRole = KNOWN_ROLES.has(m.role ?? "")
    ? (m.role as NodeRole)
    : "unknown";
  const toolNames = Array.isArray(m.content)
    ? m.content
        .filter((p) => p.type === "toolCall" && typeof p.name === "string")
        .map((p) => p.name as string)
    : [];
  // bashExecution has no `content` text; preview its command. branchSummary /
  // compactionSummary carry a `summary` string.
  const raw =
    role === "bashExecution"
      ? (m.command ?? "")
      : role === "branchSummary" || role === "compactionSummary"
        ? (m.summary ?? "")
        : contentText(m.content);
  // A tool-only assistant step has no prose; preview the tools it ran.
  const preview = firstLine(raw) || (toolNames.length ? toolNames.join(", ") : "");
  return { role, preview, hasToolCall: toolNames.length > 0, toolNames };
}

// An assistant message that is only tool calls (no prose) — the noise a
// "no tools" view collapses along with tool-result messages.
function isToolOnlyAssistant(node: FlatNode): boolean {
  const m = node.message;
  return (
    node.entry.type === "message" &&
    m?.role === "assistant" &&
    m.hasToolCall &&
    m.toolNames.join(", ") === m.preview
  );
}

export const FILTER_MODES = [
  "default",
  "no-tools",
  "user-only",
  "labeled-only",
  "all",
] as const;
export type FilterMode = (typeof FILTER_MODES)[number];

// A tree node flattened to a render row: depth for indentation, the resolved
// message facet (message entries only), and the structural flags the renderer
// and keyboard nav need.
export interface FlatNode {
  id: string;
  depth: number;
  entry: SessionEntry;
  label?: string;
  isActive: boolean;
  isBranchPoint: boolean;
  hasChildren: boolean;
  message?: MessageFacet;
}

// Project a single tree node to its render row (no recursion). Shared by
// flattenTree and the recursive renderer so both agree on facet + flags.
export function toFlatNode(
  node: SessionTreeNode,
  depth: number,
  leafId: string | null,
): FlatNode {
  const entry = node.entry;
  return {
    id: entry.id,
    depth,
    entry,
    label: node.label,
    isActive: entry.id === leafId,
    isBranchPoint: node.children.length > 1,
    hasChildren: node.children.length > 0,
    message: entry.type === "message" ? messageFacet(entry.message) : undefined,
  };
}

// The depth a node's children render at: a branch point (>1 child) indents its
// divergent lines; a single child stays on the same spine (the linear case).
export function childDepth(node: SessionTreeNode, depth: number): number {
  return node.children.length > 1 ? depth + 1 : depth;
}

// Depth-first flatten of pi's pre-nested tree (children already nested — no
// childrenMap build, unlike FleetTree). Preserves order; records depth so the
// renderer can indent branches and draw connectors. Order matches the recursive
// renderer, so it doubles as the keyboard-navigation sequence.
export function flattenTree(
  tree: SessionTreeNode[],
  leafId: string | null,
): FlatNode[] {
  const out: FlatNode[] = [];
  const walk = (nodes: SessionTreeNode[], depth: number): void => {
    for (const node of nodes) {
      out.push(toFlatNode(node, depth, leafId));
      walk(node.children, childDepth(node, depth));
    }
  };
  walk(tree, 0);
  return out;
}

// Whether a row is visible under a filter. The active leaf is never hidden (you
// always see where you are). `default` drops meta noise (model / thinking-level
// changes, standalone label entries) and tool-result messages; `no-tools` drops
// only tool results; `user-only` and `labeled-only` are literal; `all` shows
// everything.
export function matchesFilter(node: FlatNode, mode: FilterMode): boolean {
  if (node.isActive) return true;
  if (mode === "all") return true;
  const type = node.entry.type;
  const role = node.message?.role;
  if (mode === "user-only") return type === "message" && role === "user";
  if (mode === "labeled-only") return Boolean(node.label);
  // `default` and `no-tools` share a baseline: hide meta noise (model / thinking
  // changes, standalone label entries) and tool-result messages.
  if (type === "model_change" || type === "thinking_level_change" || type === "label") {
    return false;
  }
  if (type === "message" && role === "toolResult") return false;
  // `no-tools` goes further, collapsing tool-only assistant steps so only user
  // turns and assistant prose remain.
  if (mode === "no-tools" && isToolOnlyAssistant(node)) return false;
  return true;
}

// A short human label for an entry row's role/kind eyebrow.
export function nodeRoleLabel(node: FlatNode): string {
  if (node.entry.type === "message") {
    switch (node.message?.role) {
      case "user":
        return "you";
      case "assistant":
        return "agent";
      case "toolResult":
        return "tool";
      case "bashExecution":
        return "bash";
      default:
        return node.message?.role ?? "msg";
    }
  }
  switch (node.entry.type) {
    case "compaction":
      return "compacted";
    case "model_change":
      return "model";
    case "thinking_level_change":
      return "thinking";
    case "branch_summary":
      return "branch";
    case "session_info":
      return "session";
    case "label":
      return "label";
    default:
      return node.entry.type;
  }
}
