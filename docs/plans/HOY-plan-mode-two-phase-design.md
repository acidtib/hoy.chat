# Two-phase plan mode: design → approve → plan

Design for the P1 follow-up from HOY-276: give Hoy's plan mode the superpowers
`brainstorming` half — an explicit, user-approved *design* (2-3 approaches +
rationale) before the step-by-step plan gets written — using the `ask_question`
gate the user pointed at.

## Goal

When Hoy plans a non-trivial change, it should propose 2-3 distinct approaches,
let the user pick one via an `ask_question` card, and only then write the plan —
and the emitted plan should carry the design rationale (approaches weighed, the
choice, the constraints). Today plan mode explores and drops a finished plan in
one turn with no approach-level gate; "Keep planning" re-runs the whole turn.

## Approaches considered

- **A) Prompt-forward, single turn (chosen).** Restructure `PLAN_MODE_PROMPT` so the
  model's process is explore → present approaches via one `ask_question` call
  (which blocks the turn until the user answers) → write the plan for the chosen
  approach → emit the existing `<proposed_plan>` block. `ask_question` (HOY-253)
  already renders a blocking QuestionnaireCard with per-option descriptions and a
  recommended option, and is `allow`ed in plan mode (`hoy-permissions.ts:63`). No
  new store state, card, Rust, or renderer code.
- **B) New "design" sub-state + card.** A distinct design phase before plan, with
  its own "Approve design → Draft plan" card, a `designReady[threadId]` store slice,
  and a second handoff. Faithful to the superpowers two-file split, but a large
  surface change (store + ThreadView + Rust mode plumbing) for marginal gain over A
  in v1.
- **C) Format-only.** Just add design sections to `PROPOSED_PLAN_FORMAT`, no gate.
  Cheapest, but skips the *approve-before-planning* value the user asked for.

**Chosen: A.** It delivers the approve-before-plan gate (the essence of "two-phase")
with a sidecar-prompt-only change — lowest risk, and it uses `ask_question` exactly
as intended. C's format enrichment folds into A. B is a possible v2 if we later want
a separate persisted design artifact.

## Design rationale

- **The gate lives in the prompt, not new UI, because `ask_question` already IS the
  gate.** It blocks the turn and returns the user's pick, so the same turn can branch
  into planning the chosen approach. Building a bespoke design card would duplicate
  that machinery.
- **The design gate is inline-only.** `PLAN_MODE_PROMPT` drives interactive plan mode;
  the autonomous Plan *subagent* (`hoy-agents-registry.ts`) can't gate on a user, so
  the `ask_question` step goes only in `PLAN_MODE_PROMPT`. The richer output *sections*
  go in the shared `PROPOSED_PLAN_FORMAT`, so both the inline plan and the subagent
  emit design rationale.
- **Trivial changes skip the gate.** A one-line, one-obvious-way change shouldn't fire
  a 3-approach card. Threshold mirrors the existing "write a plan file when 3+ steps /
  multiple files" rule; below it, the model states its single approach in the rationale
  section and proceeds.

## Key changes

### Edit: `packages/sidecar/pi-src/hoy-system-prompt.ts` — `PROPOSED_PLAN_FORMAT`
Add two sections right after `## Summary` (design before steps):
- `## Approaches considered` — the 2-3 approaches weighed, each a sentence with its
  tradeoff, and which one this plan builds + why (or "one reasonable approach" in one line).
- `## Design rationale` — key decisions and hard constraints (named, with file:line where
  it helps); one or two tight paragraphs.

### Edit: `packages/sidecar/pi-src/hoy-system-prompt.ts` — `PLAN_MODE_PROMPT`
Rewrite `## Your Process` step 3 into the **design gate**: for non-trivial work, identify
2-3 distinct approaches and present them with a single `ask_question` call (one question,
each approach an option with label = name and description = tradeoff, recommended option =
the model's pick), wait for the choice, then plan around it. Skip only for a single obvious
approach, recording it in the rationale section. Keep steps 1 (clarify), 2 (explore), and 4
(detail the plan) otherwise intact.

### Add: `packages/sidecar/pi-src/hoy-system-prompt.test.ts` (or a new focused test)
Assert `PROPOSED_PLAN_FORMAT` contains the two new section headers and `PLAN_MODE_PROMPT`
instructs the approaches gate via `ask_question`. (Content-level guard; the existing test
only covers `HOY_SYSTEM_PROMPT`.)

## Steps

1. Add `## Approaches considered` + `## Design rationale` to `PROPOSED_PLAN_FORMAT`
   (after Summary). Verify: `cd packages/sidecar && bun test`.
2. Rewrite `PLAN_MODE_PROMPT` step 3 into the `ask_question` design gate + trivial escape.
3. Add prompt-content assertions. Verify: `bun test` (sidecar) green.
4. Rebuild sidecar if needed and live-verify in `tauri:dev` (`~/.hoyd`, DeepSeek): a
   non-trivial plan request presents an approaches `ask_question` card; picking one yields
   a plan with the two new sections; a trivial request skips the card. Screenshot.
5. Commit + push; file/roll into the HOY-276 follow-up ticket.

## Test plan

- Sidecar unit: prompt-content assertions pass; existing `hoy-system-prompt.test.ts` stays green.
- Live: drive plan mode from Default (rides HOY-291 auto-switch) with a non-trivial ask →
  confirm the approaches card, pick, confirm plan carries Approaches considered + Design
  rationale. Drive a trivial ask → confirm no gate. Confirm the Plan subagent still emits a
  valid plan (richer sections, no gate).

## Assumptions and risks

- **Model compliance:** the gate is prompt-driven, so a model may occasionally skip the
  `ask_question` step or over-fire it on trivial asks. Mitigated by an explicit threshold and
  a recommended option; acceptable for v1 (same reliability posture as the rest of plan mode).
- **Latency:** the gate adds one user round-trip mid-turn. That's the intended cost of
  approve-before-plan; the trivial escape keeps small asks fast.
- **No persisted design artifact in v1:** rationale rides inside the plan rather than a
  separate `*-design.md`. If we want the two-file split later, that's approach B (v2).

## Critical files

- `packages/sidecar/pi-src/hoy-system-prompt.ts` (edit — `PROPOSED_PLAN_FORMAT`, `PLAN_MODE_PROMPT`)
- `packages/sidecar/pi-src/hoy-permissions.ts` (reference — `ask_question` allowed in plan mode)
- `packages/sidecar/pi-src/hoy-agents-registry.ts` (reference — Plan subagent shares the format, no gate)
- `packages/sidecar/pi-src/hoy-system-prompt.test.ts` (edit — content assertions)
