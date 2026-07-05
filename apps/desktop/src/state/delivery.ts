// HOY-233 Phase 2: pure helpers around subagent threads. No Tauri imports (import
// type only) so bun test can load this module standalone. The side-effectful
// wiring lives in store.ts. HOY-300 removed the async-delivery layer (results now
// return in-band via respondSubagentResult); the tree/identity helpers remain.
import type { Project, Turn } from "../lib/types";

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
