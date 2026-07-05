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
