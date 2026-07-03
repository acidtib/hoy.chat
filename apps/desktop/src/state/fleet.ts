// HOY-235: pure fleet selectors over Project[]/live store slices. No Tauri
// imports (import type only) so bun test can load this module standalone,
// same rule delivery.ts follows. Side-effectful wiring (useSessionStore
// reads) stays in the fleet components.
import type { Project, SessionStats, Thread, Turn } from "../lib/types";
import { childThreadIdsOf, descendantThreadIdsOf } from "./delivery";

export type FleetStatus = "running" | "queued" | "done" | "error";

// Narrow a store record to only the given ids (HOY-249). A fleet component
// subscribes to just its members' slice via useShallow, so a streaming delta
// from an unrelated thread does not re-render it. The selectors below look up
// by id, so a member-only slice yields identical results to the full record.
export function pickByIds<V>(record: Record<string, V>, ids: string[]): Record<string, V> {
  const out: Record<string, V> = {};
  for (const id of ids) if (id in record) out[id] = record[id];
  return out;
}

// A fleet root: a non-subagent thread with at least one child. A single
// direct child is enough to qualify; depth >= 2 is not required.
export function fleetRoots(projects: Project[]): Thread[] {
  return projects
    .flatMap((p) => p.threads)
    .filter((t) => !t.parentThreadId && childThreadIdsOf(projects, t.id).length > 0);
}

// rootId + every descendant (root first, depth-first), for one fleet. Ids
// that fail to resolve are skipped, mirroring delivery.ts's guarded lookups.
export function fleetMembers(projects: Project[], rootId: string): Thread[] {
  const byId = new Map(projects.flatMap((p) => p.threads).map((t) => [t.id, t]));
  const root = byId.get(rootId);
  if (!root) return [];
  const members: Thread[] = [root];
  for (const id of descendantThreadIdsOf(projects, rootId)) {
    const t = byId.get(id);
    if (t) members.push(t);
  }
  return members;
}

// Priority: running beats a stale error (a fresh run in flight supersedes an
// error left over from a prior turn), error beats queued, queued beats done.
// `done` is the resting state for anything not currently running/queued/erroring.
export function fleetStatus(
  threadId: string,
  streaming: Record<string, boolean>,
  agentQueue: string[],
  threadErrors: Record<string, string | null>,
): FleetStatus {
  if (streaming[threadId]) return "running";
  if (threadErrors[threadId]) return "error";
  if (agentQueue.includes(threadId)) return "queued";
  return "done";
}

// Sum of tokens/cost across memberIds, skipping ids with no stats yet (never
// run). An all-null set returns 0/0, not NaN.
export function fleetRollup(
  memberIds: string[],
  stats: Record<string, SessionStats | null>,
): { tokens: number; cost: number } {
  let tokens = 0;
  let cost = 0;
  for (const id of memberIds) {
    const s = stats[id];
    if (!s) continue;
    tokens += s.tokens.total;
    cost += s.cost;
  }
  return { tokens, cost };
}

// Per-status counts across memberIds, for the rollup bar.
export function fleetStatusCounts(
  memberIds: string[],
  streaming: Record<string, boolean>,
  agentQueue: string[],
  threadErrors: Record<string, string | null>,
): Record<FleetStatus, number> {
  const counts: Record<FleetStatus, number> = { running: 0, queued: 0, done: 0, error: 0 };
  for (const id of memberIds) {
    counts[fleetStatus(id, streaming, agentQueue, threadErrors)] += 1;
  }
  return counts;
}

// The tool a running row is currently in, derived from its transcript rather
// than stored separately: the last assistant turn's last running tool block.
export function currentTool(turns: Turn[]): string | null {
  let last: Extract<Turn, { role: "assistant" }> | undefined;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.role === "assistant") {
      last = t;
      break;
    }
  }
  if (!last || !last.streaming) return null;
  for (let i = last.blocks.length - 1; i >= 0; i--) {
    const b = last.blocks[i];
    if (b.kind === "tool" && b.tool.running) return b.tool.title || b.tool.name;
  }
  return null;
}
