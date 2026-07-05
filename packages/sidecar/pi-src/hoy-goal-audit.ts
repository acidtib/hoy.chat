// Goal Mode v3 (HOY-299) one-shot READ-ONLY auditor. Like hoy-goal-eval and
// hoy-verify-command, this is a short-lived invocation of the SAME compiled
// sidecar binary, selected by the HOY_GOAL_AUDIT env var in hoy-sidecar.ts. Rust
// (sidecar.rs::audit_goal) spawns us, captures the {met, reason} JSON on stdout,
// and exits us; we never reach runRpcMode. Task B's loop calls this as an
// independent check: instead of trusting only the tool-less transcript
// evaluator, it spawns a read-only subagent that inspects the ACTUAL repo files
// and reports whether the condition holds.
//
// READ-ONLY GUARANTEE: unlike the tool-less evaluator (tools: []), the auditor
// runs a genuine agentic tool loop, but only over the Explore toolset
// (read, grep, find, ls). We resolve that toolset from the subagent registry's
// built-in "Explore" type and then defensively strip any mutate tool (bash,
// edit, write, agent) in case a project override widened it. The SDK's
// `tools` option is a name allowlist applied to the base tool registry
// (createAllToolDefinitions builds all seven; the allowlist activates only the
// listed names), so a non-empty read-only allowlist yields a real file-reading
// agent that CANNOT mutate the repo.
//
// SELF-TERMINATION (load-bearing): Rust calls us via a synchronous .output()
// with no timeout of its own (mirroring evaluate_goal/verify_goal_command), so
// the one-shot MUST self-terminate. A full agentic loop could otherwise hang. We
// apply BOTH guards, mirroring hoy-verify-command's teardown discipline:
//   1. A TURN BUDGET: we count turn_end events and abort the session once the
//      budget (default 12) is spent, so a runaway tool loop stops.
//   2. An ABSOLUTE wall-clock FAILSAFE: an env-overridable timeout
//      (HOY_GOAL_AUDIT_TIMEOUT_MS, default 180s, clamped) after which, if the run
//      has not settled, we abort the session and force-emit a timed-out result,
//      exiting UNCONDITIONALLY. A settled/emitted flag guards against a double
//      emit (normal completion vs. the failsafe firing).
//
// FAIL OPEN: every error, unparseable output, or timeout yields
// {met:false, reason:"auditor ..."} and exits 0 with that JSON on stdout. A
// false "met" would falsely stop the loop; a false "not met" merely lets it keep
// working, which is the safe bias.

import {
  AuthStorage,
  ModelRegistry,
  DefaultResourceLoader,
  SessionManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSubagentRegistry } from "./hoy-agents-registry";

export interface GoalAudit {
  met: boolean;
  reason: string;
}

// Hard ceiling on wall-clock time before we force a timed-out result. A hung or
// runaway auditor must never wedge the goal loop. Default 180s;
// HOY_GOAL_AUDIT_TIMEOUT_MS overrides it (clamped) so tests can drive a short
// timeout without waiting three minutes.
const DEFAULT_AUDIT_TIMEOUT_MS = 180_000;
const MIN_AUDIT_TIMEOUT_MS = 1_000;
const MAX_AUDIT_TIMEOUT_MS = 600_000;

// Turn budget: cap the agentic loop's completed turns. The auditor should reach a
// verdict in a handful of read/grep/find/ls turns; this stops a model that keeps
// exploring. HOY_GOAL_AUDIT_MAX_TURNS overrides it (clamped) for tuning/tests.
const DEFAULT_AUDIT_MAX_TURNS = 12;
const MIN_AUDIT_MAX_TURNS = 1;
const MAX_AUDIT_MAX_TURNS = 50;

// Cheap-model heuristic: model ids that name a small/fast tier. Used to pick an
// inexpensive auditor when the caller did not pin HOY_GOAL_AUDIT_MODEL.
const CHEAP_MODEL_RE = /(haiku|mini|flash|small|lite|nano)/i;

// Tools that mutate state, reach external systems, or spawn further agents. The
// auditor must never hold any of these; we strip them from the resolved toolset
// defensively. "mcp" is included so a project Explore override that added an MCP
// tool cannot survive into the read-only auditor even if such a tool were ever
// registered in this one-shot.
const MUTATE_TOOLS = new Set(["bash", "edit", "write", "agent", "mcp"]);
// If the registry cannot be read (or yields nothing usable), fall back to the
// canonical Explore read-only set so the auditor still runs read-only.
const FALLBACK_READONLY_TOOLS = ["read", "grep", "find", "ls"];

const AUDITOR_SYSTEM_PROMPT = [
  "You are a strict READ-ONLY goal-completion auditor.",
  "You are given a GOAL CONDITION. Verify whether it holds against the ACTUAL files in this project.",
  "You have read-only tools (read, grep, find, ls) and MUST NOT modify anything: do not write, edit, or run commands, and do not ask for those abilities.",
  "Base your judgment ONLY on what the files actually contain right now, not on any prior conversation, assumption, or intent.",
  'Return exactly one JSON object of the form {"met": boolean, "reason": string} and nothing else.',
  'Set "met" to true ONLY when the files show clear, direct evidence the condition is fully satisfied.',
  'If the evidence is partial, ambiguous, indirect, or absent, set "met" to false. Treat any uncertainty as not met.',
  'Keep "reason" to one or two plain sentences citing the files (with paths) that drove the decision.',
  "Do not wrap the JSON in code fences. Do not add commentary before or after it. Do not use emojis or em-dashes.",
].join("\n");

function resolveTimeoutMs(): number {
  const raw = process.env.HOY_GOAL_AUDIT_TIMEOUT_MS;
  if (!raw) return DEFAULT_AUDIT_TIMEOUT_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_AUDIT_TIMEOUT_MS;
  return Math.min(MAX_AUDIT_TIMEOUT_MS, Math.max(MIN_AUDIT_TIMEOUT_MS, n));
}

function resolveMaxTurns(): number {
  const raw = process.env.HOY_GOAL_AUDIT_MAX_TURNS;
  if (!raw) return DEFAULT_AUDIT_MAX_TURNS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_AUDIT_MAX_TURNS;
  return Math.min(MAX_AUDIT_MAX_TURNS, Math.max(MIN_AUDIT_MAX_TURNS, n));
}

// Resolve the read-only toolset from the subagent registry's built-in Explore
// type, then strip any mutate/spawn tool defensively. This is the read-only
// guarantee: whatever the registry says, the auditor never holds bash/edit/write/
// agent. Missing/empty -> the canonical Explore set.
function resolveReadOnlyTools(agentDir: string, cwd: string): string[] {
  let declared: unknown = undefined;
  try {
    const reg = loadSubagentRegistry(agentDir, cwd);
    declared = reg["Explore"]?.tools;
  } catch {
    // fall through to the fallback set
  }
  const list = Array.isArray(declared)
    ? declared.filter((t): t is string => typeof t === "string" && !MUTATE_TOOLS.has(t))
    : [];
  return list.length > 0 ? list : [...FALLBACK_READONLY_TOOLS];
}

// Parse the model's reply into a GoalAudit. Tries a whole-string JSON parse
// first, then the first {...} object found in the text. Any shape that does not
// yield a boolean `met` is treated as an error (fail open). Mirrors
// hoy-goal-eval's parseEvaluation.
function parseAudit(text: string): GoalAudit {
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
  return { met: false, reason: `auditor error: unparseable model output: ${trimmed.slice(0, 200)}` };
}

// Read the user's configured default provider/model from <agentDir>/settings.json
// (the same file the app writes: { "defaultProvider": ..., "defaultModel": ... }).
// Guarded: a missing or malformed file yields null so pickModel skips to the next
// step rather than throwing.
function readSettingsDefault(
  agentDir: string,
): { provider: string; model?: string } | null {
  try {
    const raw = readFileSync(join(agentDir, "settings.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    const provider = typeof obj.defaultProvider === "string" ? obj.defaultProvider.trim() : "";
    if (!provider) return null;
    const model = typeof obj.defaultModel === "string" ? obj.defaultModel.trim() : "";
    return { provider, model: model || undefined };
  } catch {
    return null;
  }
}

// Pick the auditor model. Order: (1) an explicit HOY_GOAL_AUDIT_MODEL
// ("provider/id"); (2) a cheap-tier model FROM the settings default provider;
// (3) the exact settings default provider/model if available; (4) any cheap-tier
// model from another provider; (5) any available model. Returns undefined only
// when no model has usable auth at all.
//
// The settings-default preference mirrors the v1 evaluator's session-provider
// fix (hoy-goal-eval.pickModel): a bare cross-provider cheap-tier match can
// resolve to a decommissioned id (e.g. an old anthropic haiku) that still lists
// as "available" but returns empty output, failing the audit open ("not met")
// every turn. The auditor has NO session transcript to read a provider from, so
// its analog of "the session's provider" is the settings default provider, which
// shares the user's working credentials.
function pickModel(
  registry: ModelRegistry,
  available: ReturnType<ModelRegistry["getAvailable"]>,
  agentDir: string,
): ReturnType<ModelRegistry["find"]> | undefined {
  const pinned = process.env.HOY_GOAL_AUDIT_MODEL?.trim();
  if (pinned) {
    const slash = pinned.indexOf("/");
    if (slash > 0) {
      const found = registry.find(pinned.slice(0, slash), pinned.slice(slash + 1));
      if (found) return found;
    }
  }
  const settings = readSettingsDefault(agentDir);
  if (settings) {
    const providerCheap = available.find(
      (m) => m.provider === settings.provider && CHEAP_MODEL_RE.test(m.id),
    );
    if (providerCheap) return providerCheap;
    if (settings.model) {
      const exact = registry.find(settings.provider, settings.model);
      if (exact) return exact;
    }
  }
  const cheap = available.find((m) => CHEAP_MODEL_RE.test(m.id));
  if (cheap) return cheap;
  return available[0];
}

// Write the JSON result and exit 0. Uses stdout.end (not write + immediate exit)
// so the payload flushes on a pipe before the process goes away, and guards
// against a double emit (normal completion vs. the failsafe timer).
let emitted = false;
function emit(result: GoalAudit): never {
  if (!emitted) {
    emitted = true;
    process.exitCode = 0;
    process.stdout.end(JSON.stringify({ met: result.met, reason: result.reason }), () => process.exit(0));
  }
  // Already emitted: do NOT write again and do NOT process.exit here (that could
  // truncate the still-flushing first write); the pending end() callback exits.
  return undefined as never;
}

export async function runGoalAudit(agentDir: string, cwd: string): Promise<never> {
  const condition = process.env.HOY_GOAL_CONDITION?.trim();
  if (!condition) return emit({ met: false, reason: "auditor error: no goal condition provided" });

  const timeoutMs = resolveTimeoutMs();
  const maxTurns = resolveMaxTurns();

  // `settled` is the single source of truth shared by the normal path and the
  // failsafe timer; whichever fires first wins and the other becomes a no-op.
  let settled = false;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;

  // Absolute wall-clock failsafe: if the agentic loop has not settled by the
  // deadline, abort the session so the model stops and force-emit a fail-open
  // timed-out result, exiting UNCONDITIONALLY. Nothing (a stuck tool, a wedged
  // stream) can make the one-shot hang past here. Mirrors hoy-verify-command.
  const failsafeTimer = setTimeout(() => {
    if (settled) return;
    settled = true;
    try {
      void session?.abort();
    } catch {
      // best effort; we are exiting regardless
    }
    emit({ met: false, reason: "auditor timed out" });
  }, timeoutMs);
  failsafeTimer.unref?.();

  try {
    const tools = resolveReadOnlyTools(agentDir, cwd);
    // Logged to stderr (never stdout) so the controller can confirm the auditor
    // is read-only without corrupting the JSON result.
    console.error(`hoy-goal-audit: tools=${tools.join(",")}`);

    // Resolve auth + models from Hoy's agent dir, same files the RPC
    // sidecar reads. getAvailable() is the set with usable credentials.
    const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
    const registry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
    const available = registry.getAvailable();
    const model = pickModel(registry, available, agentDir);
    if (!model) {
      if (!settled) {
        settled = true;
        clearTimeout(failsafeTimer);
        emit({ met: false, reason: "auditor error: no model with usable auth available for audit" });
      }
      return undefined as never;
    }
    console.error(`hoy-goal-audit: model=${model.provider}/${model.id}`);

    // The auditor prompt replaces pi's coding prompt entirely; the empty
    // appendSystemPromptOverride stops DefaultResourceLoader appending any
    // APPEND_SYSTEM.md, and noContextFiles keeps ambient project context out so
    // the verdict rests only on files the auditor itself reads via tools.
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      noContextFiles: true,
      systemPromptOverride: () => AUDITOR_SYSTEM_PROMPT,
      appendSystemPromptOverride: () => [],
    });
    await loader.reload();

    const created = await createAgentSession({
      model,
      thinkingLevel: "off",
      authStorage,
      modelRegistry: registry,
      // Non-empty READ-ONLY allowlist: activates only these names on the base
      // tool registry, so the agent can read files but cannot mutate the repo.
      tools,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
    });
    session = created.session;

    // Turn budget: count completed turns and abort once the budget is spent, so a
    // runaway tool loop cannot exhaust the wall-clock. abort() is the same clean
    // stop as a user cancel; prompt() then resolves and we read whatever the
    // model last said (fail open if it is not a verdict).
    let turns = 0;
    session.subscribe((event) => {
      if (event.type === "turn_end") {
        turns += 1;
        if (turns >= maxTurns) void session?.abort();
      }
    });

    session.setAutoCompactionEnabled(false);
    const userPrompt = [
      "GOAL CONDITION:",
      condition,
      "",
      "Investigate the actual files in this project now using your read-only tools, then decide whether the condition holds.",
      'Respond with only the JSON object {"met": boolean, "reason": string}.',
    ].join("\n");
    await session.prompt(userPrompt);

    // The failsafe may have fired while prompt() was in flight; if so it already
    // emitted and we must not emit again.
    if (settled) return undefined as never;
    settled = true;
    clearTimeout(failsafeTimer);
    const reply = session.getLastAssistantText() ?? "";
    emit(parseAudit(reply));
    return undefined as never;
  } catch (e) {
    if (!settled) {
      settled = true;
      clearTimeout(failsafeTimer);
      emit({ met: false, reason: `auditor error: ${e instanceof Error ? e.message : String(e)}` });
    }
    return undefined as never;
  } finally {
    try {
      session?.dispose();
    } catch {
      // ignore teardown errors; we are exiting
    }
  }
}
