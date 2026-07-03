import { describe, expect, test } from "bun:test";
import { createHoyAskQuestion, HOY_ASK_PREFIX, _internal, type AskAnswer } from "./hoy-ask-question";

const { toPayload, fallbackOptions, summarize, parseAnswers, answersFromFallback } = _internal;

// Fake ExtensionAPI: capture the registered tool.
function mount() {
  let tool: any;
  const pi: any = { registerTool: (t: any) => (tool = t), registerCommand: () => {}, on: () => {} };
  createHoyAskQuestion()(pi);
  return tool;
}

// Fake ctx with a scripted select that captures the title it was called with.
function ctx(select: (title: string, options: string[]) => Promise<string | undefined>) {
  const seen: { title?: string; options?: string[] } = {};
  return {
    ctx: {
      ui: {
        select: (title: string, options: string[]) => {
          seen.title = title;
          seen.options = options;
          return select(title, options);
        },
        notify: () => {},
      },
    } as any,
    seen,
  };
}

const twoQ = {
  questions: [
    {
      id: "db",
      header: "Database",
      question: "Which database?",
      options: [
        { value: "pg", label: "Postgres", description: "relational" },
        { value: "sqlite", label: "SQLite", preview: "file: app.db" },
      ],
      recommendedValue: "pg",
    },
    {
      id: "feat",
      header: "Features",
      question: "Which features?",
      multiSelect: true,
      options: [
        { value: "a", label: "Auth" },
        { value: "b", label: "Billing" },
      ],
    },
  ],
};

describe("ask_question tool", () => {
  test("registers a tool named ask_question with guidelines", () => {
    const tool = mount();
    expect(tool.name).toBe("ask_question");
    expect(tool.label).toBe("Ask Question");
    expect(Array.isArray(tool.promptGuidelines)).toBe(true);
    expect(tool.promptGuidelines.length).toBeGreaterThan(0);
  });

  test("empty questions throws", async () => {
    const tool = mount();
    const { ctx: c } = ctx(async () => undefined);
    await expect(tool.execute("c0", { questions: [] }, undefined, undefined, c)).rejects.toThrow(/at least one/);
  });

  test("smuggles the payload through the select title with the HOY_ASK prefix", async () => {
    const tool = mount();
    const { ctx: c, seen } = ctx(async () => undefined);
    await tool.execute("c1", twoQ, undefined, undefined, c);
    expect(seen.title!.startsWith(HOY_ASK_PREFIX)).toBe(true);
    const payload = JSON.parse(seen.title!.slice(HOY_ASK_PREFIX.length));
    expect(payload.questions).toHaveLength(2);
    expect(payload.questions[0].recommendedValue).toBe("pg");
    // fallback options are the first question's labels plus Other
    expect(seen.options).toEqual(["Postgres", "SQLite", "Other"]);
  });

  test("a cancelled dialog degrades to a cancelled result, does not throw", async () => {
    const tool = mount();
    const { ctx: c } = ctx(async () => undefined);
    const res = await tool.execute("c2", twoQ, undefined, undefined, c);
    expect(res.details.cancelled).toBe(true);
    expect(res.details.answers).toEqual([]);
    expect(res.content[0].text).toMatch(/assumption/i);
  });

  test("a structured JSON value comes back as parsed answers", async () => {
    const tool = mount();
    const answers: AskAnswer[] = [
      { questionId: "db", kind: "option", selectedValues: ["pg"], selectedLabels: ["Postgres"] },
      { questionId: "feat", kind: "multi", selectedValues: ["a", "b"], selectedLabels: ["Auth", "Billing"] },
    ];
    const { ctx: c } = ctx(async () => JSON.stringify({ answers }));
    const res = await tool.execute("c3", twoQ, undefined, undefined, c);
    expect(res.details.cancelled).toBe(false);
    expect(res.details.answers).toEqual(answers);
    expect(res.content[0].text).toContain("Postgres");
    expect(res.content[0].text).toContain("Auth, Billing");
  });

  test("a plain fallback label (renderer ignored the prefix) maps to a single option answer", async () => {
    const tool = mount();
    const { ctx: c } = ctx(async () => "SQLite");
    const res = await tool.execute("c4", twoQ, undefined, undefined, c);
    expect(res.details.answers).toEqual([
      { questionId: "db", kind: "option", selectedValues: ["sqlite"], selectedLabels: ["SQLite"] },
    ]);
  });
});

describe("toPayload", () => {
  test("defaults multiSelect to false and carries preview", () => {
    const p = toPayload(twoQ);
    expect(p.questions[0].multiSelect).toBe(false);
    expect(p.questions[1].multiSelect).toBe(true);
    expect(p.questions[0].options[1].preview).toBe("file: app.db");
  });

  test("drops a recommendedValue that matches no option", () => {
    const p = toPayload({
      questions: [{ id: "x", header: "h", question: "q?", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], recommendedValue: "ghost" }],
    });
    expect(p.questions[0].recommendedValue).toBeUndefined();
  });
});

describe("parseAnswers", () => {
  const payload = toPayload(twoQ);

  test("returns null on non-JSON", () => {
    expect(parseAnswers("not json", payload)).toBeNull();
  });

  test("returns null when answers is missing", () => {
    expect(parseAnswers(JSON.stringify({ nope: 1 }), payload)).toBeNull();
  });

  test("filters answers whose questionId is unknown", () => {
    const raw = JSON.stringify({
      answers: [
        { questionId: "db", kind: "option", selectedValues: ["pg"], selectedLabels: ["Postgres"] },
        { questionId: "bogus", kind: "option", selectedValues: ["z"], selectedLabels: ["Z"] },
      ],
    });
    const parsed = parseAnswers(raw, payload)!;
    expect(parsed).toHaveLength(1);
    expect(parsed[0].questionId).toBe("db");
  });

  test("preserves custom text answers", () => {
    const raw = JSON.stringify({
      answers: [{ questionId: "db", kind: "custom", selectedValues: [], selectedLabels: [], text: "MySQL" }],
    });
    const parsed = parseAnswers(raw, payload)!;
    expect(parsed[0].kind).toBe("custom");
    expect(parsed[0].text).toBe("MySQL");
  });
});

describe("answersFromFallback", () => {
  const payload = toPayload(twoQ);

  test("a matching label becomes an option answer", () => {
    expect(answersFromFallback("Postgres", payload)).toEqual([
      { questionId: "db", kind: "option", selectedValues: ["pg"], selectedLabels: ["Postgres"] },
    ]);
  });

  test("a non-matching choice (Other) becomes a custom answer", () => {
    const a = answersFromFallback("something else", payload);
    expect(a[0].kind).toBe("custom");
    expect(a[0].text).toBe("something else");
  });
});

describe("summarize", () => {
  const payload = toPayload(twoQ);

  test("renders option and custom answers as prose", () => {
    const text = summarize(payload, [
      { questionId: "db", kind: "option", selectedValues: ["pg"], selectedLabels: ["Postgres"] },
      { questionId: "feat", kind: "custom", selectedValues: [], selectedLabels: [], text: "none" },
    ]);
    expect(text).toContain("Which database? -> Postgres");
    expect(text).toContain("(custom) none");
  });

  test("no answers yields a clear note", () => {
    expect(summarize(payload, [])).toMatch(/no answers/i);
  });
});

describe("fallbackOptions", () => {
  test("first question labels plus Other; empty questions yields just Other", () => {
    expect(fallbackOptions(toPayload(twoQ))).toEqual(["Postgres", "SQLite", "Other"]);
    expect(fallbackOptions({ questions: [] })).toEqual(["Other"]);
  });
});
