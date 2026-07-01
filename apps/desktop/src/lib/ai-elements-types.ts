// Quarantine for the AI SDK type shapes that AI Elements blocks expect. We do
// not install the Vercel AI SDK (`ai` / `@ai-sdk/*`); these local definitions
// let the presentational blocks compile while our own state drives them. Keep
// this file as the single place AI-SDK prop-shape adaptation lives.

export type MessageRole = "user" | "assistant" | "system";

export type ToolState =
  | "input-streaming"
  | "input-available"
  | "approval-requested"
  | "approval-responded"
  | "output-available"
  | "output-error"
  | "output-denied";

// Mirrors the fields the AI Elements `tool` block reads from a ToolUIPart.
export type ToolUIPart = {
  type: `tool-${string}`;
  state: ToolState;
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

export type FileUIPart = {
  type: "file";
  mediaType?: string;
  filename?: string;
  url?: string;
};
