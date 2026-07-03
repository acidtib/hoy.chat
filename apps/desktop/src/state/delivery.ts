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

// Ids of the direct children of parentId (depth is capped at 1, so no
// grandchildren exist). Used to cascade archive/delete so a child is never
// left rootless when its parent leaves the tree. HOY-238.
export function childThreadIdsOf(projects: Project[], parentId: string): string[] {
  return projects
    .flatMap((p) => p.threads)
    .filter((t) => t.parentThreadId === parentId)
    .map((t) => t.id);
}
