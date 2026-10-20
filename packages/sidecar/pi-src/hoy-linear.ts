// HOY-346: Linear tools for agents. Each call is a blocking `@hoy/linear:`
// input round-trip that Rust answers with the stored Linear credential, so the
// token never enters this process. Registered only when Rust spawns the session
// with HOY_LINEAR=1 (Linear connected).
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const LINEAR_PREFIX = "@hoy/linear:";

export const LINEAR_TOOLS = [
  "linear_issue",
  "linear_comment",
  "linear_set_state",
  "linear_create_issue",
];

const issueParam = Type.String({
  description: "Issue identifier like HOY-123 (or its id).",
});

export const LINEAR_GUIDELINES = [
  "When you were handed a Linear issue, read it with linear_issue first: its comments can change the task.",
  "When you finish, post a short summary with linear_comment (what changed, how it was verified, anything left open), then move the issue with linear_set_state: done when the work is complete, or a review state if the team has one and a human should look.",
  "File work you discover but should not do now as a follow-up with linear_create_issue instead of expanding the task. Use relation sub_issue for a piece of this issue, blocked_by when this issue cannot finish without it.",
  "Do not close or cancel an issue you did not work on unless the user asked.",
];

type Answer = { ok: true; result: unknown } | { ok: false; error: string };

async function call(ctx: ExtensionContext, payload: Record<string, unknown>) {
  const raw = await ctx.ui.input(`${LINEAR_PREFIX}${JSON.stringify(payload)}`);
  if (raw === undefined) throw new Error("The Linear request was cancelled.");
  let answer: Answer;
  try {
    answer = JSON.parse(raw);
  } catch {
    throw new Error(`Unexpected Linear response: ${raw}`);
  }
  if (!answer.ok) throw new Error(answer.error);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(answer.result, null, 2) }],
    details: { result: answer.result },
  };
}

export function createHoyLinear() {
  return function hoyLinear(pi: ExtensionAPI) {
    pi.registerTool({
      name: "linear_issue",
      label: "Linear Issue",
      description:
        "Read a Linear issue: title, state, description, recent comments, and the team's workflow states.",
      promptSnippet: "linear_issue (read a Linear issue and its comments)",
      promptGuidelines: LINEAR_GUIDELINES,
      parameters: Type.Object({ issue: issueParam }),
      execute: async (_id, params, _signal, _onUpdate, ctx) =>
        call(ctx, { action: "get", issue: params.issue }),
    });

    pi.registerTool({
      name: "linear_comment",
      label: "Linear Comment",
      description: "Post a Markdown comment on a Linear issue.",
      promptSnippet: "linear_comment (comment on a Linear issue)",
      parameters: Type.Object({
        issue: issueParam,
        body: Type.String({ description: "Comment body, Markdown." }),
      }),
      execute: async (_id, params, _signal, _onUpdate, ctx) =>
        call(ctx, { action: "comment", issue: params.issue, body: params.body }),
    });

    pi.registerTool({
      name: "linear_set_state",
      label: "Linear Set State",
      description:
        "Move a Linear issue to a workflow state. `state` is a state name from linear_issue (e.g. \"In Review\") or a type: started, done, canceled, todo, backlog.",
      promptSnippet: "linear_set_state (move a Linear issue, e.g. to done)",
      parameters: Type.Object({
        issue: issueParam,
        state: Type.String({ description: "State name or type." }),
      }),
      execute: async (_id, params, _signal, _onUpdate, ctx) =>
        call(ctx, { action: "set_state", issue: params.issue, state: params.state }),
    });

    pi.registerTool({
      name: "linear_create_issue",
      label: "Linear Create Issue",
      description:
        "Create a Linear issue, usually a follow-up to the one you are working on. It lands in the source issue's team (or `team`, a team key) and is linked by `relation`.",
      promptSnippet: "linear_create_issue (file a follow-up or sub-issue in Linear)",
      parameters: Type.Object({
        title: Type.String(),
        description: Type.Optional(Type.String({ description: "Markdown body." })),
        issue: Type.Optional(
          Type.String({ description: "The source issue this one follows from." }),
        ),
        relation: Type.Optional(
          Type.Union(
            [
              Type.Literal("follow_up"),
              Type.Literal("sub_issue"),
              Type.Literal("blocks"),
              Type.Literal("blocked_by"),
              Type.Literal("none"),
            ],
            {
              description:
                "How it relates to `issue`: follow_up (related, default), sub_issue (child of it), blocks (`issue` blocks the new one, which cannot start first), blocked_by (`issue` cannot finish until the new one is done), none.",
            },
          ),
        ),
        team: Type.Optional(
          Type.String({ description: "Team key, when there is no source issue." }),
        ),
      }),
      execute: async (_id, params, _signal, _onUpdate, ctx) =>
        call(ctx, { action: "create", ...params }),
    });
  };
}
