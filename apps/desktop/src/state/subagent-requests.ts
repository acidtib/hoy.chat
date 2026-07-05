// HOY-300: pending synchronous-subagent requests. When the parent's agent tool
// blocks on ctx.ui.input, Rust surfaces a subagentSpawnSync event; the store
// records the child->request mapping here and, on the child's done, answers the
// parent's blocked request with the child's result. Pure (no Tauri imports).
export type SubagentRequest = {
  parentThreadId: string;
  parentSessionId: string;
  requestId: string;
};

const subagentRequests = new Map<string, SubagentRequest>();

export function recordSubagentRequest(childThreadId: string, req: SubagentRequest): void {
  subagentRequests.set(childThreadId, req);
}

export function takeSubagentRequest(childThreadId: string): SubagentRequest | undefined {
  const req = subagentRequests.get(childThreadId);
  if (req) subagentRequests.delete(childThreadId);
  return req;
}

export function frameSubagentResult(subagentType: string, resultText: string): string {
  return `[${subagentType} subagent result]\n\n${resultText}`;
}

// HOY-300: drop and return the child thread ids whose pending request belongs to
// this parent (used when the parent is stopped/torn down: its blocked tool is
// already cancelled by Rust, so its outstanding children must be stopped and
// their mappings cleared, or a late child done answers a dead request).
export function takeChildRequestsForParent(parentThreadId: string): string[] {
  const ids: string[] = [];
  for (const [childId, req] of subagentRequests) {
    if (req.parentThreadId === parentThreadId) ids.push(childId);
  }
  for (const id of ids) subagentRequests.delete(id);
  return ids;
}

// Test-only: clear the module-level map between test files. The map is a real
// singleton in production (one pending-request table per running app), so tests
// that record entries must reset it in beforeEach to stay isolated (HOY-300).
export function __resetSubagentRequests(): void {
  subagentRequests.clear();
}
