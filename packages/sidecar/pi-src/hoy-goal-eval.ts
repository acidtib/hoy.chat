// Goal Mode (HOY-263) one-shot transcript evaluator. Like hoy-oauth, this is a
// short-lived invocation of the SAME compiled sidecar binary, selected by the
// HOY_GOAL_EVAL env var in hoy-sidecar.ts. Rust (sidecar.rs::evaluate_goal)
// spawns us, captures stdout, and exits us; we never reach runRpcMode. Task 5's
// loop calls this once per check to judge whether a thread's goal condition is
// met, then decides whether to keep working.
//
// SPIKE decision (Step 1): we use option (b) - a throwaway in-memory session via
// the public SDK entry `createAgentSession`, prompted ONCE with `tools: []`, a
// custom strict-evaluator system prompt, context files off, and auto-compaction
// disabled. Chosen over (a) a direct `modelRegistry` streamSimple/Context call
// because option (b) reuses the exact bootstrap the rest of hoy-sidecar already
// relies on: ModelRegistry resolves auth (API key AND OAuth) internally, and
// createAgentSession + SessionManager.inMemory + DefaultResourceLoader are all
// concretely typed in the shipped .d.ts and demonstrated in the SDK examples
// (examples/sdk/01,02,03,11). Option (a) would force us to resolve request auth
// headers and drive the provider stream by hand - a lower, more fragile surface
// with more ways to mishandle OAuth. The completion is a single tool-less turn,
// so the heavier session machinery costs nothing extra here.
//
// FAIL OPEN: every error path yields {met:false, reason:"evaluator error: ..."}
// and exits 0 with that JSON on stdout. A false "met" would falsely stop the
// loop; a false "not met" merely lets it keep working, which is the safe bias.

import {
  AuthStorage,
  ModelRegistry,
  DefaultResourceLoader,
  SessionManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

export interface GoalEvaluation {
  met: boolean;
  reason: string;
}

// Bound what we send the evaluator so cost stays predictable regardless of how
// long the thread has run. We take the tail of the transcript (most recent
// evidence) up to these caps.
const MAX_MESSAGES = 24;
const MAX_TRANSCRIPT_CHARS = 12000;

// Cheap-model heuristic: model ids that name a small/fast tier. Used to pick an
// inexpensive judge when the caller did not pin HOY_GOAL_EVAL_MODEL.
const CHEAP_MODEL_RE = /(haiku|mini|flash|small|lite|nano)/i;

const STRICT_EVALUATOR_PROMPT = [
  "You are a strict goal-completion evaluator.",
  "You are given a GOAL CONDITION and a partial TRANSCRIPT of an agent working toward it.",
  "Judge ONLY from the evidence surfaced in the transcript. You have no tools and cannot read files, run commands, or verify anything yourself.",
  'Return exactly one JSON object of the form {"met": boolean, "reason": string} and nothing else.',
  'Set "met" to true ONLY when the transcript shows clear, direct evidence the condition is fully satisfied.',
  'If the evidence is partial, ambiguous, indirect, or absent, set "met" to false. Treat any uncertainty as not met.',
  'Keep "reason" to one or two plain sentences citing what in the transcript drove the decision.',
  "Do not wrap the JSON in code fences. Do not add commentary before or after it.",
].join("\n");

// Extract readable text from a Pi message content field, which may be a plain
// string or an array of typed content blocks. Defensive by design: the goal
// evaluator must never throw on an unexpected shape, so anything we cannot
// classify is skipped rather than trusted.
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    } else if (b.type === "toolCall" || typeof b.toolName === "string" || typeof b.name === "string") {
      const name = (b.toolName ?? b.name) as string | undefined;
      if (name) parts.push(`[tool: ${name}]`);
    }
  }
  return parts.join("\n");
}

// Render the tail of the transcript as a bounded plain-text block. Walks from
// the newest message backward, keeping messages until either the message cap or
// the character budget is hit, then restores chronological order.
function renderTranscript(messages: readonly unknown[]): string {
  const lines: string[] = [];
  let total = 0;
  for (let i = messages.length - 1; i >= 0 && lines.length < MAX_MESSAGES; i--) {
    const msg = messages[i] as Record<string, unknown> | null;
    if (!msg || typeof msg !== "object") continue;
    const role = typeof msg.role === "string" ? msg.role : "unknown";
    const text = contentToText(msg.content).trim();
    if (!text) continue;
    const line = `[${role}]\n${text}`;
    if (total + line.length > MAX_TRANSCRIPT_CHARS && lines.length > 0) break;
    lines.push(line);
    total += line.length;
  }
  lines.reverse();
  return lines.join("\n\n");
}

// Parse the model's reply into a GoalEvaluation. Tries a whole-string JSON parse
// first, then falls back to the first {...} object found in the text. Any shape
// that does not yield a boolean `met` is treated as an error (fail open).
function parseEvaluation(text: string): GoalEvaluation {
  const candidates: string[] = [];
  const trimmed = text.trim();
  if (trimmed) candidates.push(trimmed);
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (match) candidates.push(match[0]);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && typeof (parsed as Record<string, unknown>).met === "boolean") {
        const obj = parsed as Record<string, unknown>;
        const reason = typeof obj.reason === "string" && obj.reason.trim() ? obj.reason.trim() : "(no reason given)";
        return { met: obj.met as boolean, reason };
      }
    } catch {
      // try next candidate
    }
  }
  return { met: false, reason: `evaluator error: unparseable model output: ${trimmed.slice(0, 200)}` };
}

function emit(result: GoalEvaluation): never {
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

// Pick the judge model. Order: an explicit HOY_GOAL_EVAL_MODEL ("provider/id"),
// then a cheap-tier model FROM THE SESSION'S OWN PROVIDER, then the thread's own
// main model, then any cheap-tier model from another provider, then any available
// model. Returns undefined only when no model has usable auth at all.
//
// The session-provider preference is deliberate: a bare cross-provider cheap-tier
// match can resolve to a decommissioned id (e.g. an old anthropic haiku) that
// still lists as "available" but returns empty output, which would fail the goal
// open ("not met") every turn and never let it complete. The session's provider
// shares the thread's working credentials, so its cheap model is the safe default.
function pickModel(
  registry: ModelRegistry,
  available: ReturnType<ModelRegistry["getAvailable"]>,
  sessionModel: { provider: string; modelId: string } | null,
): ReturnType<ModelRegistry["find"]> | undefined {
  const pinned = process.env.HOY_GOAL_EVAL_MODEL?.trim();
  if (pinned) {
    const slash = pinned.indexOf("/");
    if (slash > 0) {
      const found = registry.find(pinned.slice(0, slash), pinned.slice(slash + 1));
      if (found) return found;
    }
  }
  if (sessionModel) {
    const providerCheap = available.find(
      (m) => m.provider === sessionModel.provider && CHEAP_MODEL_RE.test(m.id),
    );
    if (providerCheap) return providerCheap;
    const main = registry.find(sessionModel.provider, sessionModel.modelId);
    if (main) return main;
  }
  const cheap = available.find((m) => CHEAP_MODEL_RE.test(m.id));
  if (cheap) return cheap;
  return available[0];
}

export async function runGoalEval(agentDir: string, cwd: string): Promise<never> {
  try {
    const condition = process.env.HOY_GOAL_CONDITION?.trim();
    if (!condition) emit({ met: false, reason: "evaluator error: no goal condition provided" });

    const sessionFile = process.env.HOY_SESSION_FILE;
    if (!sessionFile) emit({ met: false, reason: "evaluator error: no session file provided" });

    // Read the transcript off the thread's own session file. buildSessionContext
    // resolves compaction/branches and returns the messages plus the thread's
    // main model, which we reuse as the judge fallback.
    let messages: unknown[] = [];
    let sessionModel: { provider: string; modelId: string } | null = null;
    try {
      const sm = SessionManager.open(sessionFile as string);
      const ctx = sm.buildSessionContext();
      messages = ctx.messages ?? [];
      sessionModel = ctx.model ?? null;
    } catch (e) {
      emit({ met: false, reason: `evaluator error: could not open session: ${e instanceof Error ? e.message : String(e)}` });
    }

    const transcript = renderTranscript(messages);
    if (!transcript) emit({ met: false, reason: "evaluator error: transcript is empty; no evidence to judge" });

    // Resolve auth + models from Hoy's agent dir, same files the RPC
    // sidecar reads. getAvailable() is the set with usable credentials.
    const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
    const registry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
    const available = registry.getAvailable();
    const model = pickModel(registry, available, sessionModel);
    if (!model) emit({ met: false, reason: "evaluator error: no model with usable auth available for evaluation" });

    // Logged to stderr (never stdout) so the controller can confirm the judge is
    // the cheap model without corrupting the JSON result.
    console.error(`hoy-goal-eval: model=${model!.provider}/${model!.id}`);

    // Strict evaluator prompt replaces pi's coding prompt entirely; the empty
    // appendSystemPromptOverride stops DefaultResourceLoader appending any
    // APPEND_SYSTEM.md, and noContextFiles keeps project context out of the
    // judge's view (cost + focus).
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      noContextFiles: true,
      systemPromptOverride: () => STRICT_EVALUATOR_PROMPT,
      appendSystemPromptOverride: () => [],
    });
    await loader.reload();

    const { session } = await createAgentSession({
      model: model!,
      thinkingLevel: "off",
      authStorage,
      modelRegistry: registry,
      tools: [],
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
    });

    try {
      // A single tool-less turn: no follow-up, no compaction, no persistence.
      session.setAutoCompactionEnabled(false);
      const userPrompt = [
        "GOAL CONDITION:",
        condition as string,
        "",
        "TRANSCRIPT (most recent messages, oldest first):",
        transcript,
        "",
        'Respond with only the JSON object {"met": boolean, "reason": string}.',
      ].join("\n");
      await session.prompt(userPrompt);
      const reply = session.getLastAssistantText() ?? "";
      emit(parseEvaluation(reply));
    } finally {
      session.dispose();
    }
  } catch (e) {
    emit({ met: false, reason: `evaluator error: ${e instanceof Error ? e.message : String(e)}` });
  }
}
