// Plan-mode handoff (HOY-213). The architect (inline plan mode or a delivered
// Plan-subagent result) wraps its finished plan in a proposed_plan block, the
// same contract the sidecar prompts enforce (PROPOSED_PLAN_FORMAT). When a
// plan-mode turn completes carrying such a block, the renderer surfaces a
// "Plan ready" card that hands the plan into execution.

const PROPOSED_PLAN_RE = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i;

// The plan text inside the last proposed_plan block of `text`, trimmed, or null
// when there is none. Non-greedy so a single well-formed block is extracted; the
// caller passes the concatenated assistant-turn text.
export function extractProposedPlan(text: string): string | null {
  const match = PROPOSED_PLAN_RE.exec(text);
  if (!match) return null;
  const plan = match[1].trim();
  return plan.length > 0 ? plan : null;
}

// The synthetic prompt that kicks off execution once the user approves a plan.
// Mirrors the pi-plan-mode handoff string; the plan itself is already in the
// thread context, but restating it as the opening instruction makes the turn
// unambiguous.
export function planKickoffPrompt(plan: string | undefined): string {
  const head =
    "Plan mode is now disabled. Full tool access is restored. Implement this approved plan now, following the steps in order.";
  return plan ? `${head}\n\n${plan}` : head;
}
