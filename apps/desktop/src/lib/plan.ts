// Plan-mode handoff (HOY-213). The architect (inline plan mode or a delivered
// Plan-subagent result) wraps its finished plan in a proposed_plan block, the
// same contract the sidecar prompts enforce (PROPOSED_PLAN_FORMAT). When a
// plan-mode turn completes carrying such a block, the renderer surfaces a
// "Plan ready" card that hands the plan into execution.

const PROPOSED_PLAN_RE = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i;

const OPEN_TAG = "<proposed_plan>";
const CLOSE_TAG = "</proposed_plan>";

// The plan text inside the last proposed_plan block of `text`, trimmed, or null
// when there is none. Non-greedy so a single well-formed block is extracted; the
// caller passes the concatenated assistant-turn text.
export function extractProposedPlan(text: string): string | null {
  const match = PROPOSED_PLAN_RE.exec(text);
  if (!match) return null;
  const plan = match[1].trim();
  return plan.length > 0 ? plan : null;
}

// A rendered slice of an assistant text block: either inline markdown prose or a
// proposed_plan block that should be drawn as its own card (HOY-259).
export type PlanSegment =
  | { kind: "markdown"; text: string }
  | { kind: "plan"; text: string; streaming: boolean };

// Split an assistant text-block into ordered segments so a proposed_plan block
// renders as a card while the surrounding prose stays inline markdown. Handles
// streaming gracefully: an unclosed <proposed_plan> streams into the card
// (streaming: true), and a partial opening/closing tag at the very tail is
// withheld rather than flashed as raw "<proposed_pl…" text mid-stream.
export function splitPlanSegments(content: string): PlanSegment[] {
  const segments: PlanSegment[] = [];
  let rest = content;

  for (;;) {
    const openIdx = indexOfCI(rest, OPEN_TAG);
    if (openIdx === -1) {
      // No further complete plan block; withhold a dangling partial open tag.
      pushMarkdown(segments, dropTrailingPartial(rest, OPEN_TAG));
      break;
    }
    pushMarkdown(segments, rest.slice(0, openIdx));
    const afterOpen = rest.slice(openIdx + OPEN_TAG.length);
    const closeIdx = indexOfCI(afterOpen, CLOSE_TAG);
    if (closeIdx === -1) {
      // Body still streaming; withhold a dangling partial close tag.
      segments.push({
        kind: "plan",
        text: dropTrailingPartial(afterOpen, CLOSE_TAG),
        streaming: true,
      });
      break;
    }
    segments.push({ kind: "plan", text: afterOpen.slice(0, closeIdx), streaming: false });
    rest = afterOpen.slice(closeIdx + CLOSE_TAG.length);
  }

  return segments;
}

function pushMarkdown(segments: PlanSegment[], text: string): void {
  if (text.length > 0) segments.push({ kind: "markdown", text });
}

function indexOfCI(haystack: string, needle: string): number {
  return haystack.toLowerCase().indexOf(needle.toLowerCase());
}

// Drop the longest suffix of `text` that is a nonempty proper prefix of `tag`, so
// a tag arriving one chunk at a time (e.g. ending "<proposed_pl") isn't shown as
// raw text before it completes.
function dropTrailingPartial(text: string, tag: string): string {
  const max = Math.min(text.length, tag.length - 1);
  for (let len = max; len > 0; len--) {
    const suffix = text.slice(text.length - len).toLowerCase();
    if (tag.slice(0, len).toLowerCase() === suffix) {
      return text.slice(0, text.length - len);
    }
  }
  return text;
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
