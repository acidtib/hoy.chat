// HOY-253: renderer-side mirror of the ask_question payload the sidecar smuggles
// through the extension-UI select title (packages/sidecar/pi-src/hoy-ask-question.ts).
// The tool calls ctx.ui.select("HOY_ASK:" + JSON.stringify(payload), ...); Rust
// passes the unknown-prefixed title through untouched, so the ApprovalCard keys
// off HOY_ASK_PREFIX and renders a QuestionnaireCard. The card answers with
// respondPermission({ value: JSON.stringify({ answers }) }), which the sidecar
// parses. Keep this shape in sync with the sidecar module.

export const HOY_ASK_PREFIX = "HOY_ASK:";

export interface AskOption {
  value: string;
  label: string;
  description?: string;
  preview?: string;
}

export interface AskQuestion {
  id: string;
  header: string;
  question: string;
  multiSelect: boolean;
  options: AskOption[];
  recommendedValue?: string;
}

export interface AskPayload {
  questions: AskQuestion[];
}

export interface AskAnswer {
  questionId: string;
  kind: "option" | "multi" | "custom";
  selectedValues: string[];
  selectedLabels: string[];
  text?: string;
}

// Parse a select title into an ask payload, or null if it is an ordinary select
// (no HOY_ASK prefix) or the JSON is malformed / has no questions. Callers fall
// back to the flat-option ApprovalCard when this returns null.
export function parseAskPayload(title: string): AskPayload | null {
  if (!title.startsWith(HOY_ASK_PREFIX)) return null;
  try {
    const data = JSON.parse(title.slice(HOY_ASK_PREFIX.length));
    if (!data || !Array.isArray(data.questions) || data.questions.length === 0) return null;
    return data as AskPayload;
  } catch {
    return null;
  }
}
