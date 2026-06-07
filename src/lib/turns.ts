// Thin mapper from streaming AgentEvents to the per-thread transcript. Each
// submit appends a user turn followed by an in-flight assistant turn (the last
// element); every event folds into that assistant turn. Pure: returns a new list.

import type { AgentEvent, ToolUI, Turn } from "./types";

export function applyEvent(turns: Turn[], event: AgentEvent): Turn[] {
  const last = turns[turns.length - 1];
  if (!last || last.role !== "assistant") return turns;

  const assistant = { ...last, tools: [...last.tools] };

  switch (event.kind) {
    case "text":
      if (assistant.tools.length > 0) {
        assistant.textAfter = (assistant.textAfter ?? "") + event.delta;
      } else {
        assistant.text += event.delta;
      }
      break;
    case "tool": {
      const index = assistant.tools.findIndex((t) => t.id === event.toolCallId);
      if (event.phase === "start") {
        assistant.tools.push({
          id: event.toolCallId,
          name: event.toolName,
          title: toolTitle(event.toolName, event.args),
          command: commandArg(event.args),
          output: "",
          running: true,
        });
      } else if (index >= 0) {
        const tool = { ...assistant.tools[index] };
        if (event.output !== undefined) tool.output = event.output;
        if (event.phase === "end") {
          tool.running = false;
          tool.isError = event.isError;
        }
        assistant.tools[index] = tool;
      }
      break;
    }
    case "error": {
      const target = assistant.tools.length > 0 ? "textAfter" : "text";
      const existing = assistant[target] || "";
      assistant[target] = `${existing}${existing ? "\n\n" : ""}[error] ${event.message}`;
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
type AssistantTurn = Extract<Turn, { role: "assistant" }>;

export function messagesToTurns(messages: unknown[]): Turn[] {
  const turns: Turn[] = [];

  for (const raw of messages) {
    const m = raw as RawMessage;
    if (m.role === "user") {
      // Pushing a user turn means the next assistant message opens a fresh turn.
      turns.push({ role: "user", text: contentText(m.content) });
    } else if (m.role === "assistant") {
      const a = currentAssistantTurn(turns);
      const hasTools = a.tools.length > 0;
      for (const part of asParts(m.content)) {
        if (part.type === "text" && typeof part.text === "string") {
          if (hasTools) {
            a.textAfter = (a.textAfter ?? "") + part.text;
          } else {
            a.text += part.text;
          }
        } else if (part.type === "thinking" && typeof part.thinking === "string" && part.thinking) {
          // Redacted thinking arrives as an empty string; skip it so no empty
          // block renders. Pi transcripts carry no duration, seconds stays unset.
          a.reasoning = {
            text: (a.reasoning?.text ?? "") + part.thinking,
          };
        } else if (part.type === "toolCall" && typeof part.id === "string") {
          a.tools.push({
            id: part.id,
            name: part.name ?? "tool",
            title: toolTitle(part.name ?? "tool", part.arguments),
            command: commandArg(part.arguments),
            output: "",
            running: false,
          });
        }
      }
    } else if (m.role === "toolResult") {
      const last = turns[turns.length - 1];
      if (last && last.role === "assistant") {
        const tool = last.tools.find((t) => t.id === m.toolCallId);
        if (tool) {
          tool.output = contentText(m.content);
          tool.isError = m.isError;
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
    tools: [],
    text: "",
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
