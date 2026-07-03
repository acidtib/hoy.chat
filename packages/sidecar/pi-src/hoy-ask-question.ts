// HOY-253: the `ask_question` tool. Lets the agent put a structured,
// multiple-choice questionnaire to the user instead of guessing or asking a
// fragile free-text question. Primary use is the plan-mode architect nailing
// intent before finalizing a plan; equally useful in default mode when a request
// is underspecified.
//
// It rides the existing extension-UI path (HOY-186) with zero Rust changes. The
// rich questionnaire does not fit `ctx.ui.select`'s flat `options: string[]`, so
// the payload is smuggled through the `title` as a JSON prefix, exactly as
// HOY-199 smuggles tool-diff metadata via "HOY_TOOL_DATA:{json}\n". Rust's
// classify_extension_ui only special-cases the HOY_TOOL_DATA prefix; any other
// title passes through untouched, so the renderer's ApprovalCard sees "HOY_ASK:"
// and renders a QuestionnaireCard. The card answers with a JSON `value` string,
// which pi's RPC `select` returns to us verbatim (it is not constrained to the
// `options` array). On cancel/teardown the value is undefined and we degrade to a
// cancelled result rather than throwing, which would abort the agent turn.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// Title prefix the renderer keys off to render the questionnaire card instead of
// the flat select buttons. Kept in sync with apps/desktop ApprovalCard.
export const HOY_ASK_PREFIX = "HOY_ASK:";

// The card serializes answers back through the select `value` as this shape.
export interface AskAnswer {
  questionId: string;
  kind: "option" | "multi" | "custom";
  selectedValues: string[];
  selectedLabels: string[];
  text?: string;
}

interface AskOption {
  value: string;
  label: string;
  description?: string;
  preview?: string;
}
interface AskQuestion {
  id: string;
  header: string;
  question: string;
  multiSelect: boolean;
  options: AskOption[];
  recommendedValue?: string;
}

const askOption = Type.Object({
  value: Type.String({ description: "Stable id for this option; this is what gets returned to you." }),
  label: Type.String({ description: "Short display text for the option (max ~60 chars)." }),
  description: Type.Optional(Type.String({ description: "Optional one-line trade-off text shown under the label." })),
  preview: Type.Optional(
    Type.String({
      description:
        "Optional longer preview shown in a monospace box under the option when it is selected: a code snippet, ASCII mockup, or config example. Use only when a visual artifact helps the user compare options.",
    }),
  ),
});

const askQuestion = Type.Object({
  id: Type.String({ description: "Stable id for this question; echoed back as questionId." }),
  header: Type.String({ description: "Very short chip label for the question (a few words)." }),
  question: Type.String({ description: "The question to ask; should end with a question mark." }),
  multiSelect: Type.Optional(Type.Boolean({ description: "Allow selecting multiple options. Default false." })),
  options: Type.Array(askOption, { minItems: 2, maxItems: 4, description: "2 to 4 options." }),
  recommendedValue: Type.Optional(
    Type.String({ description: "The option `value` to render first and mark as recommended." }),
  ),
});

const askParams = Type.Object({
  questions: Type.Array(askQuestion, {
    minItems: 1,
    maxItems: 4,
    description: "1 to 4 questions. Group all clarifying questions into a single call.",
  }),
});

const GUIDELINES = [
  "Use ask_question when a request is underspecified and you cannot proceed without a concrete decision the user must make.",
  "Group all of your clarifying questions into a single ask_question call (up to 4); do not ask them one at a time.",
  "Do not use it for confirmations you could reasonably assume, or for questions you can answer yourself by reading the code.",
  "Give each option a stable `value`, a short `label`, and a `description` of the trade-off when it helps. Set recommendedValue when you have a clear suggestion.",
];

// Normalize the model's params into the payload the renderer receives. Drops a
// recommendedValue that does not match any option so the card never highlights a
// phantom, and defaults multiSelect to false.
function toPayload(params: any): { questions: AskQuestion[] } {
  const rawQuestions = Array.isArray(params?.questions) ? params.questions : [];
  const questions: AskQuestion[] = rawQuestions.map((q: any) => {
    const options: AskOption[] = (Array.isArray(q?.options) ? q.options : []).map((o: any) => ({
      value: String(o?.value ?? ""),
      label: String(o?.label ?? ""),
      ...(o?.description ? { description: String(o.description) } : {}),
      ...(o?.preview ? { preview: String(o.preview) } : {}),
    }));
    const recommended = options.some((o) => o.value === q?.recommendedValue) ? String(q.recommendedValue) : undefined;
    return {
      id: String(q?.id ?? ""),
      header: String(q?.header ?? ""),
      question: String(q?.question ?? ""),
      multiSelect: q?.multiSelect === true,
      options,
      ...(recommended ? { recommendedValue: recommended } : {}),
    };
  });
  return { questions };
}

// Flat option labels for the first question plus "Other", so a renderer that does
// not understand the HOY_ASK prefix still degrades to a usable single-select.
function fallbackOptions(payload: { questions: AskQuestion[] }): string[] {
  const first = payload.questions[0];
  const labels = first ? first.options.map((o) => o.label) : [];
  return [...labels, "Other"];
}

// Human-readable summary of the answers for the transcript, so the model (and a
// human reading the thread) sees the decision in prose alongside the structured
// details.
function summarize(payload: { questions: AskQuestion[] }, answers: AskAnswer[]): string {
  const byId = new Map(payload.questions.map((q) => [q.id, q]));
  const lines = answers.map((a) => {
    const q = byId.get(a.questionId);
    const label = q?.question ?? a.questionId;
    if (a.kind === "custom") return `${label} -> (custom) ${a.text ?? ""}`.trim();
    return `${label} -> ${a.selectedLabels.join(", ")}`;
  });
  return lines.length ? `The user answered:\n${lines.join("\n")}` : "The user provided no answers.";
}

// Parse the card's JSON `value` into validated answers. Returns null when the
// value is missing or malformed so the caller can fall back to the flat-option
// (fallbackOptions) interpretation.
function parseAnswers(raw: string, payload: { questions: AskQuestion[] }): AskAnswer[] | null {
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const arr = Array.isArray(data?.answers) ? data.answers : null;
  if (!arr) return null;
  const validIds = new Set(payload.questions.map((q) => q.id));
  const answers: AskAnswer[] = [];
  for (const a of arr) {
    const questionId = String(a?.questionId ?? "");
    if (!validIds.has(questionId)) continue;
    const kind = a?.kind === "multi" || a?.kind === "custom" ? a.kind : "option";
    const selectedValues = Array.isArray(a?.selectedValues) ? a.selectedValues.map(String) : [];
    const selectedLabels = Array.isArray(a?.selectedLabels) ? a.selectedLabels.map(String) : [];
    answers.push({
      questionId,
      kind,
      selectedValues,
      selectedLabels,
      ...(typeof a?.text === "string" ? { text: a.text } : {}),
    });
  }
  return answers;
}

// Map a flat fallback choice (a plain option label, or "Other") back to a single
// answer, for a renderer that ignored the HOY_ASK prefix.
function answersFromFallback(choice: string, payload: { questions: AskQuestion[] }): AskAnswer[] {
  const first = payload.questions[0];
  if (!first) return [];
  const opt = first.options.find((o) => o.label === choice);
  if (opt) {
    return [{ questionId: first.id, kind: "option", selectedValues: [opt.value], selectedLabels: [opt.label] }];
  }
  return [{ questionId: first.id, kind: "custom", selectedValues: [], selectedLabels: [], text: choice }];
}

const CANCELLED_NOTE =
  "The user dismissed the question without answering. Proceed with your best assumption and state the assumption you made.";

export function createHoyAskQuestion() {
  async function run(params: any, ctx: ExtensionContext) {
    const payload = toPayload(params);
    if (payload.questions.length === 0) {
      throw new Error("ask_question requires at least one question.");
    }
    const title = HOY_ASK_PREFIX + JSON.stringify(payload);
    const choice = await ctx.ui.select(title, fallbackOptions(payload));

    // Cancelled (teardown/abort) or an empty answer: degrade, do not throw.
    if (choice === undefined) {
      return {
        content: [{ type: "text" as const, text: CANCELLED_NOTE }],
        details: { answers: [] as AskAnswer[], cancelled: true },
      };
    }

    const answers = parseAnswers(choice, payload) ?? answersFromFallback(choice, payload);
    return {
      content: [{ type: "text" as const, text: summarize(payload, answers) }],
      details: { answers, cancelled: false },
    };
  }

  return function hoyAskQuestion(pi: ExtensionAPI) {
    pi.registerTool({
      name: "ask_question",
      label: "Ask Question",
      description:
        "Ask the user one to four structured multiple-choice questions when a request is underspecified. Renders a questionnaire the user answers; returns their selected option values. Prefer this over guessing or asking a free-text question when you need a concrete decision to proceed.",
      promptSnippet: "ask_question (put a structured multiple-choice question to the user)",
      promptGuidelines: GUIDELINES,
      parameters: askParams,
      execute: async (_id, params, _signal, _onUpdate, ctx) => run(params, ctx),
    });
  };
}

// Exposed for tests.
export const _internal = { toPayload, fallbackOptions, summarize, parseAnswers, answersFromFallback };
