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

// How an approved plan is executed (HOY-295): inline in this thread (the
// classic handoff), or task-by-task by dispatching a fresh subagent per step.
export type PlanExecution = "inline" | "subagent";

// HOY-295: the subagent-driven variant of the execution handoff. Instead of
// implementing inline, the parent orchestrates the plan one step per general-
// purpose subagent, sequentially and self-reviewing: it hands each step (and its
// Consumes/Produces contract, when the plan carries one) to a subagent, ends its
// turn, is auto-woken when that subagent's result is delivered back, reviews it,
// then dispatches the next step. The human watches each subagent thread live and
// can steer or stop it. Rides the existing spawn + result-delivery infra
// (HOY-231/233); no new plumbing beyond this instruction.
export function planSubagentKickoffPrompt(plan: string | undefined): string {
  const head = [
    "Plan mode is now disabled. Full tool access is restored. Implement this approved plan task-by-task using subagents, not inline.",
    "",
    "Execute the plan one step at a time, in order:",
    "1. Dispatch exactly one general-purpose subagent (the agent tool) for the current step. Hand it that step's full instructions, its Consumes/Produces contract if the plan gives one, and any Global Constraints, so it can work independently.",
    "2. Dispatch only one subagent at a time, then end your turn. The subagent runs in its own thread and its result is delivered back to you when it finishes; you will resume automatically — do not spawn the next step's subagent in the same turn.",
    "3. When the result arrives, review it: confirm the step was completed and its Produces contract is satisfied. If it is wrong or incomplete, fix it or re-dispatch that step before continuing.",
    "4. Once the step is verified, dispatch the next step's subagent. Repeat until every step is done, then run the plan's Test plan yourself and report the outcome.",
    "",
    "The approved plan:",
  ].join("\n");
  return plan ? `${head}\n\n${plan}` : head;
}

// HOY-291: auto-switch to Plan Mode when a message asks for a plan. Detects, on
// the human text of an outbound message, whether the user is asking Hoy to
// *produce* a plan (so submitPrompt can flip a non-plan thread into plan mode
// before the turn streams, like Claude Code). Deliberately high-precision:
// a false positive yanks the user into a write-gated mode, so we only fire on
// clear "make me a plan" phrasings and bail on the many innocuous uses of the
// word "plan" (executing an existing plan, domain nouns like "pricing plan",
// the plan file itself). Recall gaps are acceptable — the user can always pick
// Plan Mode by hand; annoying false switches are not.
export function detectPlanIntent(raw: string): boolean {
  const text = raw.toLowerCase();
  // Fast bail: no standalone "plan"/"plans" token at all.
  if (!/\bplans?\b/.test(text)) return false;

  // Negative — asking to EXECUTE/FOLLOW an existing plan, not to write one.
  // This also covers the plan-kickoff prompt ("implement this approved plan").
  if (
    /\b(implement|execut\w+|carry out|carry-out|follow|apply|code up|ship|write the code for|stick to|according to)\b[^.!?\n]{0,24}\bplans?\b/.test(
      text,
    )
  )
    return false;
  // Negative — "plan" as a domain noun, not a unit of work to design.
  if (
    /\b(pricing|price|subscription|payment|billing|data|phone|meal|travel|floor|business|game|lesson|study|savings|health|insurance|retirement|seating|dinner|wedding|birthday)\s+plans?\b/.test(
      text,
    )
  )
    return false;
  // Negative — the plan artifact itself (the file/dir/document), not a request.
  if (/\bplans?\s+(file|files|dir\w*|folder|document|doc|\.md)\b/.test(text))
    return false;

  // Positive — explicit requests to produce a plan.
  return (
    // "<verb> ... a/the plan": make a plan, come up with a plan, give me a plan.
    /\b(make|create|craft|write|draft|come up with|put together|outline|sketch|propose|prepare|formulate|devise|design|give me|show me|need|want|lay out|develop)\b[^.!?\n]{0,32}\bplans?\b/.test(
      text,
    ) ||
    // "plan out ...", "plan how ...", "plan this/it out", "plan first/before ...".
    /\bplan\b\s*(out\b|how\b|this out\b|it out\b|first\b|before\b|ahead\b|the (approach|work|migration|refactor|steps|implementation)\b)/.test(
      text,
    ) ||
    /\blet'?s\s+(first\s+)?(make\s+a\s+|come\s+up\s+with\s+a\s+)?plan\b/.test(text) ||
    /\bcan\s+you\s+(please\s+)?(make\s+a\s+|come\s+up\s+with\s+a\s+|draft\s+a\s+)?plan\b/.test(
      text,
    ) ||
    /\bplan\s+mode\b/.test(text) ||
    // Message that opens with an imperative "plan …" (but not "plan file/.md").
    /^\s*plan\b(?!\s*(file|files|\.md|:))/.test(text)
  );
}
