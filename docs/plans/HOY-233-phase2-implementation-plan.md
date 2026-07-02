# Subagents Phase 2 (async result delivery + steering) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a spawned subagent thread finishes, inject its result back into the parent thread as a marked, auto-resuming turn; flip the tool/prompt wording that said results never return.

**Architecture:** All new logic is renderer-side. A finished child's `done` event (already handled in `streamPromptOnThread`) triggers a new `deliverAndDrain(threadId)`: if the finished thread has a `parentThreadId`, its final assistant text is framed and delivered to the parent via the existing `streamPromptOnThread` (resuming the parent sidecar with a `prompt`); if the parent is mid-turn the delivery queues and drains on the parent's next `done`. Pure helpers (result extraction, message framing, the FIFO queue) live in a Tauri-free `delivery.ts` so they are unit-testable under `bun test`. No new Rust `AgentEvent` and no new Tauri command.

**Tech Stack:** React + TypeScript + Zustand store (`apps/desktop/src/state/store.ts`), Tauri v2, Pi sidecar (TypeScript, `bun test`), renderer tests via `bun test`.

## Global Constraints

- No emojis and no em-dashes anywhere (code, comments, docs, commits). Use a comma, semicolon, or separate sentences.
- Plain git commit messages, `HOY-233:` prefix, no Co-Authored-By trailers.
- No new npm/cargo dependencies. Do NOT install or wire the Vercel AI SDK.
- The delivered message the parent sidecar receives is framed exactly `[Subagent result -- <type> (<shortId>)]\n\n<resultText>` where `<shortId>` is the first 8 chars of the agentId. `--` here is a literal double-hyphen in a bracketed label, not an em-dash; keep it as two ASCII hyphens.
- `delivery.ts` must import `Turn` with `import type` only (no runtime imports from `../lib/types`), so `bun test` loads it without pulling in Tauri.
- Rebuild the sidecar binary (`packages/sidecar/build.sh`) before any live verification; a stale binary runs old prompt text (HOY-200).
- Sidecar text lives in two files that must agree: the `agent` tool's return text (`hoy-agents.ts`) and `AGENT_TOOLS_PROMPT` (`hoy-system-prompt.ts`). Both must state the result is delivered back.

---

## File Structure

- `packages/sidecar/pi-src/hoy-agents.ts` — flip the `agent` tool success text (Task 1).
- `packages/sidecar/pi-src/hoy-system-prompt.ts` — flip `AGENT_TOOLS_PROMPT` (Task 1).
- `packages/sidecar/pi-src/hoy-mcp.test.ts` — update the `buildHoySystemPrompt` agent-block assertions (Task 1).
- `apps/desktop/src/state/delivery.ts` — NEW. Pure, Tauri-free: `extractResultText`, `buildDelivery`, and the `pendingDeliveries` FIFO (`queueDelivery` / `takeNextDelivery`) (Task 2).
- `apps/desktop/src/state/delivery.test.ts` — NEW. Unit tests for the above (Task 2).
- `apps/desktop/src/lib/types.ts` — add `origin` + `subagent` to the user `Turn` variant (Task 3).
- `apps/desktop/src/state/store.ts` — wire `deliverAndDrain` / `deliverToParent` into the child `done` branch (Task 3).
- `apps/desktop/src/components/ThreadView.tsx` — render a `subagentResult` user turn as a marked note (Task 3).

---

### Task 1: Flip the tool + prompt wording (results now return)

**Files:**
- Modify: `packages/sidecar/pi-src/hoy-agents.ts:75-83` (the `agent` tool's return object text)
- Modify: `packages/sidecar/pi-src/hoy-system-prompt.ts:93-100` (`AGENT_TOOLS_PROMPT` and its comment)
- Test: `packages/sidecar/pi-src/hoy-mcp.test.ts:198-203`

**Interfaces:**
- Consumes: nothing new.
- Produces: `AGENT_TOOLS_PROMPT` still contains `Subagents:` and `Fire-and-forget`, and now contains `delivered back`. No signature changes.

- [ ] **Step 1: Update the failing test first** (`hoy-mcp.test.ts:198-203`)

Replace the existing agent-block test body so it asserts the new delivery wording:

```ts
  test("system prompt advertises the agent tool only when agent is enabled", () => {
    expect(buildHoySystemPrompt(false, false)).not.toContain("Subagents:");
    const enabled = buildHoySystemPrompt(false, true);
    expect(enabled).toContain("Subagents:");
    expect(enabled).toContain("Fire-and-forget");
    expect(enabled).toContain("delivered back");
    expect(enabled).not.toContain("does NOT come back");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/sidecar/pi-src && bun test hoy-mcp.test.ts`
Expected: FAIL on `expect(enabled).toContain("delivered back")` (current prompt says "does NOT come back to you").

- [ ] **Step 3: Flip `AGENT_TOOLS_PROMPT`** (`hoy-system-prompt.ts`)

Replace the comment at lines 93-96 and the block at lines 97-100 with:

```ts
// Appended to the base prompt only when the agent tool is available (parent
// sessions; a spawned child never has it, depth cap). Advertises the tool's
// contract so the model reaches for it deliberately: the call returns a handle
// immediately (fire-and-forget), and the subagent's result is delivered back
// into the conversation when it finishes (HOY-233).
export const AGENT_TOOLS_PROMPT = `Subagents:
- The agent tool spawns a specialized child agent that runs in its own thread. Two types: general-purpose (full tool access) and Explore (read-only: read, grep, find, ls). Call agent({subagentType, task}) with a complete, self-contained task; the subagent does not see this conversation.
- Fire-and-forget: the call returns a handle immediately and the subagent runs independently. When it finishes, its result is delivered back into this conversation as a new message, so you may keep working; you will be resumed with the subagent's result when it arrives.
- Spawning asks for user approval. A subagent cannot spawn further subagents.`;
```

- [ ] **Step 4: Flip the `agent` tool return text** (`hoy-agents.ts:75-83`)

Replace the returned object's text (and its stale header comment at lines 1-4 if it still says "no result returns") with:

```ts
    return {
      content: [
        {
          type: "text" as const,
          text: `Spawned ${type.name} subagent (${agentId}). It runs in its own thread; its result will be delivered back into this conversation when it finishes.`,
        },
      ],
      details: { agentId },
    };
```

Also update the file-header comment at `hoy-agents.ts:1-4`: change "Fire-and-forget: no result returns to the parent in this phase." to "Fire-and-forget: the call returns a handle; the subagent's result is delivered back to the parent when it finishes (HOY-233)."

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/sidecar/pi-src && bun test`
Expected: all green, including the updated agent-block assertions and the unchanged MCP assertions.

- [ ] **Step 6: Commit**

```bash
git add packages/sidecar/pi-src/hoy-agents.ts packages/sidecar/pi-src/hoy-system-prompt.ts packages/sidecar/pi-src/hoy-mcp.test.ts
git commit -m "HOY-233: subagent result is delivered back to the parent (tool + prompt text)"
```

---

### Task 2: Pure delivery helpers + queue (`delivery.ts`)

**Files:**
- Create: `apps/desktop/src/state/delivery.ts`
- Test: `apps/desktop/src/state/delivery.test.ts`

**Interfaces:**
- Consumes: `Turn` type from `../lib/types` (`import type` only), whose assistant variant has `blocks: AssistantBlock[]` (a text block is `{ kind: "text"; content: string }`), plus optional `aborted?: boolean` and `error?: string`; the user variant has `text: string`.
- Produces:
  - `type Delivery = { message: string; subagentType: string; agentId: string }`
  - `extractResultText(turns: Turn[]): string`
  - `buildDelivery(subagentType: string, agentId: string, childTurns: Turn[]): Delivery`
  - `queueDelivery(parentThreadId: string, d: Delivery): void`
  - `takeNextDelivery(parentThreadId: string): Delivery | undefined`
  - `pendingDeliveries: Map<string, Delivery[]>` (exported for test reset)

- [ ] **Step 1: Write the failing tests** (`apps/desktop/src/state/delivery.test.ts`)

```ts
import { test, expect, beforeEach } from "bun:test";
import type { Turn } from "../lib/types";
import {
  extractResultText,
  buildDelivery,
  queueDelivery,
  takeNextDelivery,
  pendingDeliveries,
} from "./delivery";

const asst = (over: Partial<Extract<Turn, { role: "assistant" }>> = {}): Turn => ({
  role: "assistant",
  blocks: [],
  streaming: false,
  ...over,
});
const text = (content: string): Turn =>
  asst({ blocks: [{ kind: "text", content }] });

beforeEach(() => pendingDeliveries.clear());

test("extractResultText joins the final assistant text blocks", () => {
  const turns: Turn[] = [
    { role: "user", text: "go" },
    text("first"),
    { role: "user", text: "again" },
    asst({ blocks: [{ kind: "text", content: "the " }, { kind: "text", content: "answer" }] }),
  ];
  expect(extractResultText(turns)).toBe("the answer");
});

test("extractResultText reports an aborted child", () => {
  expect(extractResultText([text("partial"), asst({ aborted: true })])).toBe(
    "The subagent was stopped before finishing.",
  );
});

test("extractResultText reports a failed child", () => {
  expect(extractResultText([asst({ error: "boom" })])).toBe(
    "The subagent failed: boom",
  );
});

test("extractResultText handles empty output", () => {
  expect(extractResultText([{ role: "user", text: "go" }, asst()])).toBe(
    "(the subagent produced no output.)",
  );
});

test("buildDelivery frames the message with type and short id", () => {
  const d = buildDelivery("Explore", "abcdef1234567890", [text("found it")]);
  expect(d.subagentType).toBe("Explore");
  expect(d.agentId).toBe("abcdef1234567890");
  expect(d.message).toBe("[Subagent result -- Explore (abcdef12)]\n\nfound it");
});

test("queueDelivery / takeNextDelivery is FIFO per parent", () => {
  const a = buildDelivery("Explore", "a1111111", [text("A")]);
  const b = buildDelivery("Explore", "b2222222", [text("B")]);
  queueDelivery("p", a);
  queueDelivery("p", b);
  expect(takeNextDelivery("p")).toBe(a);
  expect(takeNextDelivery("p")).toBe(b);
  expect(takeNextDelivery("p")).toBeUndefined();
});

test("takeNextDelivery on an unknown parent is undefined", () => {
  expect(takeNextDelivery("nobody")).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/desktop && bun test src/state/delivery.test.ts`
Expected: FAIL, module `./delivery` not found.

- [ ] **Step 3: Implement `delivery.ts`**

```ts
// HOY-233 Phase 2: pure helpers for delivering a finished subagent's result back
// to its parent thread. No Tauri imports (import type only) so bun test can load
// this module standalone. The side-effectful wiring lives in store.ts.
import type { Turn } from "../lib/types";

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/desktop && bun test src/state/delivery.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/state/delivery.ts apps/desktop/src/state/delivery.test.ts
git commit -m "HOY-233: pure delivery helpers (result extraction, framing, FIFO queue)"
```

---

### Task 3: Wire delivery into the store + marked rendering

**Files:**
- Modify: `apps/desktop/src/lib/types.ts:180-200` (add `origin` + `subagent` to the user `Turn` variant)
- Modify: `apps/desktop/src/state/store.ts` (import delivery helpers; add module-level `deliverAndDrain` + `deliverToParent`; call `deliverAndDrain` in the `done` branch at `store.ts:1511`)
- Modify: `apps/desktop/src/components/ThreadView.tsx:390-418` (render a `subagentResult` user turn distinctly)

**Interfaces:**
- Consumes from Task 2: `extractResultText`, `buildDelivery`, `queueDelivery`, `takeNextDelivery`, `Delivery`.
- Consumes existing store internals (all already in `store.ts`): module-level `activeChannels: Map<string, Channel<AgentEvent>>` (`store.ts:1408`), `streamPromptOnThread` (`store.ts:1416`), `acquireSession` (`store.ts:1645`), `findThread`, `patchThread`, `useSessionStore`, and the action `setThreadSessionIdInternal`.
- Produces: no exported API; internal wiring only.

- [ ] **Step 1: Extend the user `Turn` variant** (`types.ts:180-188`)

Add the two optional fields to the `role: "user"` object (leave the assistant variant unchanged):

```ts
export type Turn =
  | {
      role: "user";
      text: string;
      images?: ImageContent[];
      // @ context attached to this send (HOY-220), for display pills. Not
      // restored from disk (the content is inlined into the message text).
      contexts?: ContextRef[];
      // HOY-233: a turn injected by a finished subagent, not typed by the user.
      // Rendered as a marked result note. Not persisted: on reload pi records it
      // as a plain user message, so the framed text keeps it legible.
      origin?: "subagentResult";
      subagent?: { type: string; agentId: string };
    }
```

- [ ] **Step 2: Add the delivery import** near the other `store.ts` imports

```ts
import {
  buildDelivery,
  queueDelivery,
  takeNextDelivery,
  type Delivery,
} from "./delivery";
```

- [ ] **Step 3: Add `deliverAndDrain` and `deliverToParent`** as module-level functions in `store.ts`, directly below `streamPromptOnThread` (after its closing brace, before `const pendingSessions` is fine; place it after `streamPromptOnThread` ends)

```ts
// HOY-233: on a thread's `done`, push a finished child's result up to its parent
// and drain any deliveries that queued for this thread while it was streaming.
async function deliverAndDrain(finishedThreadId: string): Promise<void> {
  const state = useSessionStore.getState();
  const found = findThread(state.projects, finishedThreadId);
  if (!found) return;
  const { thread } = found;
  if (thread.parentThreadId) {
    const childTurns = state.turns[finishedThreadId] ?? [];
    const delivery = buildDelivery(
      thread.spawnedBy?.type ?? "subagent",
      thread.spawnedBy?.agentId ?? "",
      childTurns,
    );
    await deliverToParent(thread.parentThreadId, delivery);
  }
  // This thread may itself be a parent with a queued delivery: it just went idle,
  // so deliver the next one now (deliverToParent handles the not-busy path).
  const next = takeNextDelivery(finishedThreadId);
  if (next) await deliverToParent(finishedThreadId, next);
}

// Inject `delivery` into `parentThreadId` as a marked subagent-result turn and
// stream the parent's continuation. If the parent is mid-turn, queue instead and
// let its next `done` drain it. Resumes the parent sidecar from its transcript
// when the panel was closed.
async function deliverToParent(parentThreadId: string, delivery: Delivery): Promise<void> {
  if (activeChannels.has(parentThreadId)) {
    queueDelivery(parentThreadId, delivery);
    return;
  }
  const found = findThread(useSessionStore.getState().projects, parentThreadId);
  if (!found) return;
  const { project, thread: parent } = found;
  try {
    let sessionId = parent.sessionId ?? null;
    if (!sessionId) {
      if (!parent.sessionFile) return; // unreachable: a parent has run a turn
      sessionId = await acquireSession(parentThreadId, project.path ?? "", parent.sessionFile);
      useSessionStore.getState().setThreadSessionIdInternal(parentThreadId, sessionId);
    }
    useSessionStore.setState((s) => ({
      turns: {
        ...s.turns,
        [parentThreadId]: [
          ...(s.turns[parentThreadId] ?? []),
          {
            role: "user" as const,
            text: delivery.message,
            origin: "subagentResult" as const,
            subagent: { type: delivery.subagentType, agentId: delivery.agentId },
          },
          { role: "assistant" as const, blocks: [], streaming: true },
        ],
      },
      streaming: { ...s.streaming, [parentThreadId]: true },
      threadErrors: { ...s.threadErrors, [parentThreadId]: null },
      projects: patchThread(s.projects, parentThreadId, (th) => ({
        ...th,
        updatedAt: Date.now(),
      })),
    }));
    await streamPromptOnThread(parentThreadId, sessionId, delivery.message);
  } catch (e) {
    useSessionStore.setState((s) => ({
      streaming: { ...s.streaming, [parentThreadId]: false },
      threadErrors: {
        ...s.threadErrors,
        [parentThreadId]: String(e instanceof Error ? e.message : e),
      },
    }));
  }
}
```

- [ ] **Step 4: Call `deliverAndDrain` from the `done` branch** (`store.ts:1511`)

Immediately after the existing `void useSessionStore.getState().refreshStats(threadId);` line, add:

```ts
      void useSessionStore.getState().refreshStats(threadId);
      // HOY-233: push this child's result up to its parent, and drain any
      // deliveries queued for this thread while it streamed.
      void deliverAndDrain(threadId);
```

- [ ] **Step 5: Render a `subagentResult` turn distinctly** (`ThreadView.tsx:390-418`)

Replace the user-branch opening so a `subagentResult` turn renders as a muted, labeled note. Change the `turn.role === "user" ? (` block to branch on `origin`:

```tsx
              {turns.map((turn, i) =>
                turn.role === "user" ? (
                  turn.origin === "subagentResult" ? (
                    <div
                      key={i}
                      className="rounded-md border border-brand/40 bg-brand/5 px-3 py-2 text-sm leading-relaxed text-muted-foreground"
                    >
                      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-brand">
                        Subagent result{turn.subagent ? ` -- ${turn.subagent.type}` : ""}
                      </div>
                      <div className="whitespace-pre-wrap">{turn.text}</div>
                    </div>
                  ) : (
                    <div
                      key={i}
                      className="rounded-md border border-border/60 bg-card/40 px-3 py-2 text-sm leading-relaxed text-foreground"
                    >
                      {turn.images && turn.images.length > 0 && (
                        <div className="mb-2 flex flex-wrap gap-2">
                          {turn.images.map((img, ii) => (
                            <img
                              key={ii}
                              src={`data:${img.mimeType};base64,${img.data}`}
                              alt="attachment"
                              className="size-20 rounded-md border border-border/60 object-cover"
                            />
                          ))}
                        </div>
                      )}
                      {turn.contexts && turn.contexts.length > 0 && (
                        <div className="mb-2 flex flex-wrap gap-1.5">
                          {turn.contexts.map((ref) => (
                            <TurnContextPill key={contextKey(ref)} contextRef={ref} />
                          ))}
                        </div>
                      )}
                      {turn.text && (
                        <div className="whitespace-pre-wrap">{turn.text}</div>
                      )}
                    </div>
                  )
                ) : (
```

Note: the label uses a literal ` -- ` double-hyphen, matching the framed message; it is not an em-dash. Leave the assistant branch (`) : (` onward) untouched.

- [ ] **Step 6: Typecheck**

Run: `cd apps/desktop && bun run check:ts`
Expected: PASS, no type errors (the `origin`/`subagent` fields resolve, `deliverToParent` signatures line up).

- [ ] **Step 7: Rerun the full renderer + sidecar unit suites**

Run: `cd apps/desktop && bun test` then `cd packages/sidecar/pi-src && bun test`
Expected: PASS. `delivery.test.ts` still green; no regressions.

- [ ] **Step 8: Rebuild the sidecar and live-verify** (HOY-200: stale binary runs old text)

```bash
cd packages/sidecar && ./build.sh
```

Then via the Tauri MCP bridge in the running dev app (`bun run tauri:dev`):
1. In a thread, prompt Hoy to spawn an Explore subagent for a small, self-contained lookup.
2. Approve the consent card. Confirm the child thread appears nested under the parent.
3. When the child finishes, confirm a marked "Subagent result -- Explore" note appears in the PARENT thread and the parent continues on its own (auto-wake).
4. Spawn a second Explore while the parent is still streaming from the first result; confirm the second result queues and is delivered after the parent's current turn ends (sequential drain), not lost.
5. Open a running child and type into its composer; confirm it steers (this is the steering verify, no code expected).
6. Restart the app; confirm children still nest and reopen, and no crash from the new turn fields.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/lib/types.ts apps/desktop/src/state/store.ts apps/desktop/src/components/ThreadView.tsx
git commit -m "HOY-233: deliver a finished subagent's result into the parent thread"
```

---

## Self-Review

**Spec coverage:**
- Async result delivery (push/auto-resume) -> Task 3 (`deliverAndDrain`/`deliverToParent`), Task 2 (helpers).
- Busy-parent queue + sequential drain -> Task 2 (`queueDelivery`/`takeNextDelivery`), Task 3 (`deliverAndDrain` drain, per-`done` firing).
- Distinct rendering (not a fake user message) -> Task 3 Step 1 (Turn fields) + Step 5 (ThreadView note).
- Child error/abort delivered as a note -> Task 2 (`extractResultText`) + its tests.
- Parent-panel-closed resume via `acquireSession` -> Task 3 (`deliverToParent`).
- Tool/prompt wording flip -> Task 1.
- Steering verify -> Task 3 Step 8.5 (live-verify only; no code, matching the spec).
- Deferred (limiter, graceful max_turns, native `steer`, parent->child steer, poll) -> not in any task, as intended.

**Placeholder scan:** No TBD/TODO; every code step carries complete code. The one non-code task (steering) is a live-verify per the spec, not a placeholder.

**Type consistency:** `Delivery` shape and the four helper names (`extractResultText`, `buildDelivery`, `queueDelivery`, `takeNextDelivery`) match between Task 2's definition and Task 3's import. The user `Turn` fields `origin: "subagentResult"` and `subagent: { type, agentId }` are defined in Task 3 Step 1 and consumed in Steps 3 and 5 with the same names. `deliverToParent(parentThreadId: string, delivery: Delivery)` is called with those types in `deliverAndDrain`.

## Notes for the executor

- `deliverAndDrain` and `deliverToParent` are module-level (like `streamPromptOnThread`), not store actions, so they use `useSessionStore.getState()/setState()` directly.
- Do not add a new Rust event or Tauri command; delivery rides the existing `Done` event and `streamPromptOnThread` (which calls `send_prompt`).
- `delivery.ts` uses `import type` for `Turn`. If you switch it to a value import, `bun test` will try to load Tauri and the test will break.
- The framed label and the ThreadView label both use ` -- ` (two ASCII hyphens). This is deliberate and is not an em-dash; do not "fix" it.
