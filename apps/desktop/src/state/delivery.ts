// HOY-233 Phase 2: pure helpers for delivering a finished subagent's result back
// to its parent thread. No Tauri imports (import type only) so bun test can load
// this module standalone. The side-effectful wiring lives in store.ts.
import type { Project, Turn } from "../lib/types";

export type Delivery = { message: string; subagentType: string; agentId: string };

const NO_OUTPUT = "(the subagent produced no output.)";

// The result a parent receives: the child's final assistant turn, or a note when
// the child was aborted, failed, or produced nothing.
export function extractResultText(turns: Turn[]): string {
  let last: Extract<Turn, { role: "assistant" }> | undefined;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.role === "assistant") {
      last = t;
      break;
    }
  }
  if (!last) return NO_OUTPUT;
  if (last.aborted) return "The subagent was stopped before finishing.";
  if (last.error) return `The subagent failed: ${last.error}`;
  const body = last.blocks
    .map((b) => (b.kind === "text" ? b.content : ""))
    .join("")
    .trim();
  return body || NO_OUTPUT;
}

// The literal double-hyphen below is an ASCII separator in a label, not an em-dash.
export function buildDelivery(
  subagentType: string,
  agentId: string,
  childTurns: Turn[],
): Delivery {
  const shortId = agentId.slice(0, 8);
  const message = `[Subagent result -- ${subagentType} (${shortId})]\n\n${extractResultText(childTurns)}`;
  return { message, subagentType, agentId };
}

// Deliveries that arrived while the parent was mid-turn. Drained one per parent
// `done`, so results stay ordered and individually attributable.
export const pendingDeliveries = new Map<string, Delivery[]>();

export function queueDelivery(parentThreadId: string, d: Delivery): void {
  const q = pendingDeliveries.get(parentThreadId);
  if (q) q.push(d);
  else pendingDeliveries.set(parentThreadId, [d]);
}

export function takeNextDelivery(parentThreadId: string): Delivery | undefined {
  const q = pendingDeliveries.get(parentThreadId);
  if (!q || q.length === 0) return undefined;
  const next = q.shift();
  if (q.length === 0) pendingDeliveries.delete(parentThreadId);
  return next;
}

// A child delivers its result to its parent exactly once, on first completion.
// completedAt is set on that first delivery; a later done (e.g. a follow-up in
// the child's own composer) sees it set and does not re-inject. HOY-239.
export function shouldDeliverToParent(thread: {
  parentThreadId?: string | null;
  completedAt?: number | null;
}): boolean {
  return !!thread.parentThreadId && !thread.completedAt;
}

// On teardown of a subagent child, its parent's outstanding-children counter must
// be decremented iff the child was still outstanding: it has a parent AND had not
// yet delivered (no completedAt). A child that already delivered decremented the
// counter at apply time and was stamped completedAt, so this returns false there,
// avoiding a double-decrement (HOY-240 auto-close stamps completedAt BEFORE
// closePanel). Same shape as shouldDeliverToParent, named for the teardown call
// site. HOY-245.
export function shouldDecrementParentOnTeardown(thread: {
  parentThreadId?: string | null;
  completedAt?: number | null;
}): boolean {
  return !!thread.parentThreadId && !thread.completedAt;
}

// An intermediate agent (a subagent that is itself a parent of live children)
// must defer delivering its own result up until every child has delivered back
// into it, otherwise its result is computed before its descendants' work lands
// (a bug that only becomes reachable at depth >= 2). `outstanding` is the parent
// thread's outstanding-children count. A leaf (no children -> 0) never defers, so
// depth-1 delivery is unchanged. HOY-245.
export function shouldDeferUpDelivery(
  thread: { parentThreadId?: string | null },
  outstanding: number,
): boolean {
  return isSubagentThread(thread) && outstanding > 0;
}

// A thread is a subagent thread iff it was spawned by a parent. Drives the
// agent color identity in the sidebar and panels (HOY-236). Parent-role
// detection uses childThreadIdsOf(projects, id).length > 0.
export function isSubagentThread(thread: {
  parentThreadId?: string | null;
}): boolean {
  return !!thread.parentThreadId;
}

// Ids of the direct children of parentId only (single-level; callers that need
// the whole subtree self-recurse). Used to cascade archive/delete so a child
// is never left rootless when its parent leaves the tree. HOY-238.
export function childThreadIdsOf(projects: Project[], parentId: string): string[] {
  return projects
    .flatMap((p) => p.threads)
    .filter((t) => t.parentThreadId === parentId)
    .map((t) => t.id);
}

// Depth of a thread in the subagent tree: 0 for a root (user) thread, +1 per
// ancestor. Walks parentThreadId up. Visited-guarded against corrupt data
// (the parent link is a tree by construction, so cycles never arise normally).
export function threadDepth(projects: Project[], threadId: string): number {
  const byId = new Map(projects.flatMap((p) => p.threads).map((t) => [t.id, t]));
  const seen = new Set<string>();
  let depth = 0;
  let cur = byId.get(threadId);
  while (cur?.parentThreadId && !seen.has(cur.id)) {
    seen.add(cur.id);
    cur = byId.get(cur.parentThreadId);
    depth += 1;
  }
  return depth;
}

// Every transitive descendant of ancestorId (children, grandchildren, ...).
// For aggregate rollups; the archive/delete cascade uses childThreadIdsOf
// (single-level) because it self-recurses. Visited-guarded.
export function descendantThreadIdsOf(projects: Project[], ancestorId: string): string[] {
  const all = projects.flatMap((p) => p.threads);
  const out: string[] = [];
  const seen = new Set<string>([ancestorId]);
  const stack = [ancestorId];
  while (stack.length) {
    const parentId = stack.pop()!;
    for (const t of all) {
      if (t.parentThreadId === parentId && !seen.has(t.id)) {
        seen.add(t.id);
        out.push(t.id);
        stack.push(t.id);
      }
    }
  }
  return out;
}
