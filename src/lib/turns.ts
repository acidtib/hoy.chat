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
      assistant.text += event.delta;
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
    case "error":
      assistant.text += `${assistant.text ? "\n\n" : ""}[error] ${event.message}`;
      break;
    case "status":
      // Retry/compaction notices: not rendered inline for now.
      break;
    case "done":
      assistant.streaming = false;
      break;
  }

  return [...turns.slice(0, -1), assistant];
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
