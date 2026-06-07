// Thin mapper from streaming AgentEvents to the per-thread transcript. Each
// submit appends a user turn followed by an in-flight assistant turn (the last
// element); every event folds into that assistant turn. Pure: returns a new list.

import type { AgentEvent, ToolUI, Turn } from "./types";

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
        const tool: ToolUI = {
          id: event.toolCallId,
          name: event.toolName,
          title: toolTitle(event.toolName, event.args),
          command: commandArg(event.args),
          output: "",
          running: true,
        };
        assistant.blocks.push({ kind: "tool", tool });
      } else {
        const blockIndex = assistant.blocks.findIndex(
          (b) => b.kind === "tool" && b.tool.id === event.toolCallId,
        );
        if (blockIndex >= 0) {
          const block = assistant.blocks[blockIndex];
          if (block.kind === "tool") {
            const tool = { ...block.tool };
            if (event.output !== undefined) tool.output = event.output;
            if (event.phase === "end") {
              tool.running = false;
              tool.isError = event.isError;
            }
            assistant.blocks[blockIndex] = { ...block, tool };
          }
        }
      }
      break;
    }
    case "error": {
      const msg = `[error] ${event.message}`;
      const lastBlock = assistant.blocks[assistant.blocks.length - 1];
      if (lastBlock && lastBlock.kind === "text") {
        lastBlock.content += `\n\n${msg}`;
      } else {
        assistant.blocks.push({ kind: "text", content: msg });
      }
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
};
type RawMessage = {
  role?: string;
  content?: string | RawContentPart[];
  toolCallId?: string;
  isError?: boolean;
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
      turns.push({ role: "user", text: contentText(m.content) });
    } else if (m.role === "assistant") {
      const a = currentAssistantTurn(turns);
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

export type { ToolUI };
