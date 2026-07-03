# HOY-253: Structured `ask_question` tool + questionnaire card

**Goal:** Give the sidecar agent a tool to put a structured, multiple-choice
questionnaire to the user instead of guessing or asking fragile free-text. Primary
use is the plan-mode architect nailing intent before finalizing a plan; equally
useful in default mode when a request is underspecified. Deferred from HOY-213 as
YAGNI; now built lean.

**Status:** In progress.

## Approach: ride the existing extension-UI path (zero Rust changes)

The tool reuses `ctx.ui.select` end to end, the same primitive the HOY-186
permission cards use. The rich questionnaire (headers, per-option descriptions,
multiselect, a recommended marker, stable option values) does not fit the
`select` `options: string[]` shape, so it is smuggled through the `title` as a
JSON prefix, exactly as HOY-199 smuggles tool-diff metadata via
`HOY_TOOL_DATA:{json}\n`:

- Sidecar calls `ctx.ui.select("HOY_ASK:" + JSON.stringify(payload), fallbackOptions)`.
- Rust `classify_extension_ui` (sidecar.rs) only special-cases the
  `HOY_TOOL_DATA:` prefix; any other title passes through untouched into
  `PermissionRequest.title`. No events.rs / sidecar.rs / types.ts changes.
- Renderer `ApprovalCard` detects `HOY_ASK:`, parses the JSON, and renders a
  `QuestionnaireCard` instead of the flat option buttons.
- On submit the card answers with `respondPermission(..., { value: JSON.stringify(answers) })`.
  pi's RPC `select` parser returns that `value` string verbatim (it is not
  constrained to the `options` array), so the tool receives the structured answer.
- On cancel/teardown the value is `undefined`; the tool degrades to a
  `cancelled` result, it never throws (a throw would abort the agent turn, wrong
  for a clarifier).

`fallbackOptions` is the first question's option labels plus "Other", so a
renderer that does not understand the prefix still degrades to a usable
single-select rather than an empty card.

## Tool contract

Name `ask_question`, label "Ask Question". Registered via
`pi.registerTool` with `promptGuidelines` gating usage.

Parameters (typebox):

- `questions`: array, minItems 1, maxItems 4.
  - `id`: stable string, echoed back as `questionId`.
  - `header`: short chip label (kept tight).
  - `question`: the prompt (should end with "?").
  - `multiSelect?`: default false.
  - `options`: array, 2 to 4, each `{ value, label, description?, preview? }`.
    `value` is the stable id returned; `label` is display; `description` is
    optional trade-off text; `preview` is optional longer text (code snippet,
    ASCII mockup, config) shown in a monospace box under the option when selected.
  - `recommendedValue?`: an option `value` rendered first and marked recommended.

`preview` is rendered **stacked, not side by side**: when an option is selected
its preview appears in a monospace preformatted box directly under that option, in
the normal vertical flow. This deliberately avoids the expensive part of the
original spec (a responsive two-column layout with hover-driven panes). There is
no markdown renderer in the app, so preview is raw preformatted text (matching the
host AskUserQuestion "markdown in a monospace box" convention) with no new
dependency.

Answer returned to the model:

```
{
  content: [{ type: "text", text: <human-readable summary for the transcript> }],
  details: {
    answers: [{ questionId, kind: "option" | "multi" | "custom",
                selectedValues: string[], selectedLabels: string[], text? }],
    cancelled: boolean
  }
}
```

Returning stable `values` (not display labels) is the key upgrade over the
leanest references. A free-form "Other" row is auto-offered per question and
returns `kind: "custom"` with the typed `text`.

## Scope decisions (v1)

- Support the 1-to-4 question array (not single-only).
- Support multiselect.
- Keep the free-form "Other" escape.
- Support `recommendedValue`.
- Support `preview`, stacked under the selected option (not side by side), as a
  monospace preformatted box. No new markdown dependency.
- Main-thread only: added to `HOY_TOOLS`, not to child subagent tool sets. The
  intent-interrogation phase belongs to the thread talking to the user, not a
  fire-and-forget child.
- Always allowed by the permission gate in every mode (it is a user interaction,
  not a side effect). Without this, plan mode would block it and default mode
  would raise an approval card before the question card.

## Slice 1: sidecar tool + permission allow

- New `packages/sidecar/pi-src/hoy-ask-question.ts`: `createHoyAskQuestion()` factory,
  the `ask_question` tool, the `HOY_ASK:` payload builder, value parsing,
  and the graceful-cancel result. Export `HOY_ASK_PREFIX`.
- `hoy-sidecar.ts`: add `"ask_question"` to `HOY_TOOLS`; install
  `createHoyAskQuestion()` in `extensionFactories`.
- `hoy-permissions.ts`: `decide()` returns `allow` for `ask_question` in all
  modes (add near the top, before the mode branches). Test in the gate table.
- `hoy-ask-question.test.ts`: payload build, value parse round-trip (option / multi /
  custom), cancel path, recommended ordering, fallback options.

**Verify:** `bun test` in `packages/sidecar/pi-src`; `bun test hoy-permissions.test.ts`.

## Slice 2: renderer questionnaire card

- `ApprovalCard` (ThreadView.tsx): when `request.title` starts with `HOY_ASK:`,
  parse the JSON and render `<QuestionnaireCard payload onAnswer />` instead of
  the flat buttons.
- `QuestionnaireCard`: renders one question at a time as a stepper (progress dots
  + "N of M", Back / Next / Submit), not all questions stacked. Each question
  shows its header chip and the options as radios (single) or checkboxes (multi)
  with optional descriptions, the recommended option first with a "Recommended"
  chip, and an "Other" row with a text input. When a selected option carries
  `preview`, its text renders in a monospace preformatted box stacked directly
  under that option. Next is disabled until the current question is answered;
  Submit (on the last step) until all are. Answers accumulate across steps and
  persist when navigating Back. Submit -> `onAnswer({ value: JSON.stringify(answers) })`;
  Cancel -> `onAnswer({ cancelled: true })`.
- Types: a local payload/answer type for the parse (sidecar is a separate
  package, so the shape is mirrored, matching the existing three-way mirror
  convention for events).

**Verify:** `bun run check:ts` in `apps/desktop`; screenshot the card.

## Slice 3: prompt guidance

- `promptGuidelines` on the tool: use when the request is underspecified and you
  cannot proceed without a concrete decision; group all clarifying questions into
  a single call; do not use for confirmations you could reasonably assume. pi
  appends these to the Guidelines section only while the tool is active.

**Verify:** one-shot behavior confirmed in live-verify.

## Verification and rollout

Full `check` gate (tsc, cargo check, clippy, fmt) + `bun test` in both
`apps/desktop` and `packages/sidecar/pi-src`. Rebuild the sidecar
(`packages/sidecar/build.sh`) since `packages/sidecar` is touched. Live-verify in
the running app against `~/.hoyd/agent` (dev dir, DeepSeek): a turn that calls
`ask_question` renders the questionnaire card; answering flows the structured
result back to the model. Screenshot. Focused local commit per slice, no push.

## Out of scope (YAGNI)

- `preview` side-by-side two-column layout (v1 renders preview stacked under the
  selected option instead; the responsive split pane can come later if wanted).
- A dedicated `method: "questionnaire"` event kind (the `HOY_ASK:` title prefix
  avoids touching the three-way events mirror).
- Making the tool available to child subagents.
- i18n, tabbed multi-question navigation (all questions render stacked in v1).
