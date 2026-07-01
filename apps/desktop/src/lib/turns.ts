// Thin mapper from streaming AgentEvents to the per-thread transcript. Each
// submit appends a user turn followed by an in-flight assistant turn (the last
// element); every event folds into that assistant turn. Pure: returns a new list.

import type { AgentEvent, ImageContent, ToolUI, Turn } from "./types";

export function applyEvent(turns: Turn[], event: AgentEvent): Turn[] {
  const last = turns[turns.length - 1];
  if (!last || last.role !== "assistant") return turns;

  const assistant = { ...last, blocks: [...last.blocks] };

  switch (event.kind) {
    case "text": {
      const lastBlock = assistant.blocks[assistant.blocks.length - 1];
      if (lastBlock && lastBlock.kind === "text") {
        lastBlock.content += event.delta;
      } else {
        assistant.blocks.push({ kind: "text", content: event.delta });
      }
      break;
    }
    case "tool": {
      if (event.phase === "start") {
        // HOY-199: if any block exists for this toolCallId (pending from
        // permissionRequest, or an earlier execution event), promote/update
        // it instead of creating a duplicate.
        const existingIndex = assistant.blocks.findIndex(
          (b) => b.kind === "tool" && b.tool.id === event.toolCallId,
        );
        if (existingIndex >= 0) {
          const block = assistant.blocks[existingIndex];
          if (block.kind === "tool") {
            assistant.blocks[existingIndex] = {
              ...block,
              tool: { ...block.tool, pending: false, running: true },
            };
          }
        } else {
          const tool: ToolUI = {
            id: event.toolCallId,
            name: event.toolName,
            title: toolTitle(event.toolName, event.args),
            command: commandArg(event.args),
            diff: buildDiff(event.toolName, event.args),
            output: "",
            running: true,
          };
          assistant.blocks.push({ kind: "tool", tool });
        }
      } else {
        const blockIndex = assistant.blocks.findIndex(
          (b) => b.kind === "tool" && b.tool.id === event.toolCallId,
        );
        if (blockIndex >= 0) {
          const block = assistant.blocks[blockIndex];
          if (block.kind === "tool") {
            const tool = { ...block.tool };
            // Any post-start event means the gate cleared and the tool is
            // executing or done; it is no longer awaiting approval (HOY-199).
            tool.pending = false;
            if (event.output !== undefined) tool.output = event.output;
            if (event.phase === "end") {
              tool.running = false;
              tool.isError = event.isError;
            } else {
              tool.running = true;
            }
            assistant.blocks[blockIndex] = { ...block, tool };
          }
        }
      }
      break;
    }
    case "error":
      // Render inline at the bottom of the turn (HOY-214), not as the
      // thread-level banner. Any streamed text/tools above it are kept.
      assistant.error = event.message;
      break;
    case "aborted":
      // The user stopped the turn (HOY-197). Flag it so the transcript shows a
      // subtle inline marker; Done follows to clear the streaming state.
      assistant.aborted = true;
      break;
    case "reasoning": {
      // Fold Pi's thinking stream into a single reasoning block across the
      // turn's tool loop (HOY-211). Create it lazily so a delta with no prior
      // start (redacted thinking) still opens the block. active drives the live
      // "Thinking for Ns" timer; end stops it.
      const current = assistant.reasoning ?? { text: "", active: true };
      assistant.reasoning =
        event.phase === "end"
          ? { ...current, active: false }
          : { ...current, text: current.text + (event.delta ?? ""), active: true };
      break;
    }
    case "status":
      // Retry/compaction notices: not rendered inline for now.
      break;
    case "permissionRequest":
      // Approval cards live in store.pendingPermissions, not in the transcript.
      break;
    case "done":
      assistant.streaming = false;
      break;
  }

  return [...turns.slice(0, -1), assistant];
}

// Raw Pi message shapes (from get_messages) we read. Loosely typed: we only touch
// the fields we render, and Pi owns the canonical schema.
type RawContentPart = {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  // Image parts on a restored user message (Pi's ImageContent).
  data?: string;
  mimeType?: string;
};
type RawMessage = {
  role?: string;
  content?: string | RawContentPart[];
  toolCallId?: string;
  isError?: boolean;
  // Pi sets these on the assistant message when a turn was stopped (HOY-197) or
  // failed (HOY-214).
  stopReason?: string;
  errorMessage?: string;
};

// Fold a persisted Pi transcript (get_messages) into the same Turn[] the live
// stream produces. Pi emits one assistant message per LLM step, so a tool loop is
// assistant, toolResult, assistant, ...; we merge each run between user messages
// into a single assistant turn so restored and streamed views render identically.
// Within each message, content parts are pushed as ordered blocks so the model's
// natural interleaving (text -> toolCall -> text -> toolCall) is preserved.
type AssistantTurn = Extract<Turn, { role: "assistant" }>;

export function messagesToTurns(messages: unknown[]): Turn[] {
  const turns: Turn[] = [];

  for (const raw of messages) {
    const m = raw as RawMessage;
    if (m.role === "user") {
      turns.push({
        role: "user",
        text: stripContextBlock(contentText(m.content)),
        images: contentImages(m.content),
      });
    } else if (m.role === "assistant") {
      const a = currentAssistantTurn(turns);
      if (m.stopReason === "aborted") a.aborted = true;
      if (m.stopReason === "error") {
        a.error = m.errorMessage ?? "the agent stopped unexpectedly";
      }
      for (const part of asParts(m.content)) {
        if (part.type === "thinking" && typeof part.thinking === "string" && part.thinking) {
          a.reasoning = {
            text: (a.reasoning?.text ?? "") + part.thinking,
          };
        } else if (part.type === "text" && typeof part.text === "string") {
          const lastBlock = a.blocks[a.blocks.length - 1];
          if (lastBlock && lastBlock.kind === "text") {
            lastBlock.content += part.text;
          } else {
            a.blocks.push({ kind: "text", content: part.text });
          }
        } else if (part.type === "toolCall" && typeof part.id === "string") {
          a.blocks.push({
            kind: "tool",
            tool: {
              id: part.id,
              name: part.name ?? "tool",
              title: toolTitle(part.name ?? "tool", part.arguments),
              command: commandArg(part.arguments),
              // Keep the diff on restore so an approved or denied edit always
              // shows what changed, not just the tool's result text (HOY-199).
              diff: buildDiff(part.name ?? "tool", part.arguments),
              output: "",
              running: false,
            },
          });
        }
      }
    } else if (m.role === "toolResult") {
      const last = turns[turns.length - 1];
      if (last && last.role === "assistant") {
        const block = last.blocks.find(
          (b) => b.kind === "tool" && b.tool.id === m.toolCallId,
        );
        if (block && block.kind === "tool") {
          block.tool.output = contentText(m.content);
          block.tool.isError = m.isError;
        }
      }
    }
  }
  return turns;
}

// The open assistant turn to fold the current message run into: the last turn if
// it is already an assistant turn, otherwise a fresh one (i.e. after a user turn).
function currentAssistantTurn(turns: Turn[]): AssistantTurn {
  const last = turns[turns.length - 1];
  if (last && last.role === "assistant") return last;
  const turn: AssistantTurn = {
    role: "assistant",
    blocks: [],
    streaming: false,
  };
  turns.push(turn);
  return turn;
}

function asParts(content: string | RawContentPart[] | undefined): RawContentPart[] {
  return Array.isArray(content) ? content : [];
}

function contentText(content: string | RawContentPart[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
}

// Strip a leading @ context block from a restored user message (HOY-220). The
// content is inlined into the message text on submit; on restore we show the
// user's actual text, not the inlined files/transcripts. Matches our own
// <context>...</context> prefix only, so ordinary messages are untouched.
function stripContextBlock(text: string): string {
  if (!text.startsWith("<context>")) return text;
  const end = text.indexOf("</context>");
  if (end < 0) return text;
  return text.slice(end + "</context>".length).replace(/^\s+/, "");
}

// Image parts of a restored user message, so reopened threads keep the images the
// user sent. Returns undefined when there are none (keeps existing snapshots
// stable and avoids an empty array on text-only turns).
function contentImages(
  content: string | RawContentPart[] | undefined,
): ImageContent[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const images = content
    .filter((p) => p.type === "image" && typeof p.data === "string")
    .map((p) => ({
      type: "image" as const,
      data: p.data as string,
      mimeType: p.mimeType ?? "image/png",
    }));
  return images.length > 0 ? images : undefined;
}

// A readable one-line title from the tool's name and arguments. Bash shows its
// command; file tools show the path; search tools show the pattern.
function toolTitle(name: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  if (typeof a.command === "string") return a.command;
  const path = a.path ?? a.file ?? a.file_path ?? a.filename;
  if (typeof path === "string") return `${name} ${path}`;
  const pattern = a.pattern ?? a.query;
  if (typeof pattern === "string") return `${name} ${pattern}`;
  return name;
}

function commandArg(args: unknown): string | undefined {
  const command = (args as Record<string, unknown> | null | undefined)?.command;
  return typeof command === "string" ? command : undefined;
}

// HOY-199: build a pending tool block from permission request tool data.
// Rendered in the conversation with the "Awaiting Approval" badge while the
// approval card waits for the user's decision.
export function buildPendingToolBlock(
  toolCallId: string,
  toolName: string,
  args: unknown,
): ToolUI {
  return {
    id: toolCallId,
    name: toolName,
    title: toolTitle(toolName, args),
    command: commandArg(args),
    diff: buildDiff(toolName, args),
    output: "",
    running: false,
    pending: true,
  };
}

// HOY-199: mark a tool call as awaiting approval. Pi emits the tool `start`
// event before the permission gate, so the block almost always already exists;
// flip it to pending in place. If a permission request ever arrives before the
// start event, insert a fresh pending block instead so the diff still shows.
export function markToolPending(
  turns: Turn[],
  toolCallId: string,
  toolName: string | undefined,
  args: unknown,
): Turn[] {
  const last = turns[turns.length - 1];
  if (!last || last.role !== "assistant") return turns;
  const idx = last.blocks.findIndex(
    (b) => b.kind === "tool" && b.tool.id === toolCallId,
  );
  const blocks = [...last.blocks];
  if (idx >= 0) {
    const block = blocks[idx];
    if (block.kind !== "tool") return turns;
    blocks[idx] = {
      ...block,
      tool: { ...block.tool, pending: true, running: false },
    };
  } else {
    blocks.push({
      kind: "tool",
      tool: buildPendingToolBlock(toolCallId, toolName ?? "tool", args),
    });
  }
  return [...turns.slice(0, -1), { ...last, blocks }];
}

function buildDiff(toolName: string, args: unknown): string | undefined {
  const a = (args ?? {}) as Record<string, unknown>;
  if (toolName === "edit" && Array.isArray(a.edits)) {
    const parts: string[] = [];
    for (const edit of a.edits as Array<{ oldText: string; newText: string }>) {
      for (const line of edit.oldText.split("\n")) parts.push(`- ${line}`);
      for (const line of edit.newText.split("\n")) parts.push(`+ ${line}`);
    }
    return parts.join("\n");
  }
  if (toolName === "write" && typeof a.content === "string") {
    return a.content
      .split("\n")
      .map((line) => `+ ${line}`)
      .join("\n");
  }
  return undefined;
}

export type { ToolUI };
