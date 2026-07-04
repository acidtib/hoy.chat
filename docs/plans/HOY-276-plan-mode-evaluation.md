# HOY-276: Evaluate Hoy's plan mode vs the superpowers planning workflow

Spike deliverable: compare Hoy's built-in plan mode to the Claude Code + "superpowers"
workflow we've actually used to build Hoy, identify gaps, and recommend what to adopt
(with follow-up tickets). Related: HOY-264 (the split-home spec/plan pair cited as the bar),
HOY-291 (auto-switch to plan mode — just shipped).

## Method

Compared three things directly:

- **Hoy's plan mode as prompted** — `PLAN_MODE_PROMPT` and `PROPOSED_PLAN_FORMAT` in
  `packages/sidecar/pi-src/hoy-system-prompt.ts:126-200`, the tool gate in
  `hoy-permissions.ts` (read-only + writes only under `.hoy/plans/`), and the Implement
  handoff (`store.ts` `flagPlanReadyIfPresent`/`implementPlan`, `ThreadView` `ProposedPlanCard`).
- **Hoy's plan mode as it actually runs** — drove four live plans during HOY-291
  verification (CSV export, keyboard shortcuts, dark mode, offline support). Representative
  output shape: `Summary → Key changes → Steps → Test plan → Assumptions and risks →
  Critical files`, with three Implement buttons.
- **The superpowers workflow** — the `brainstorming` and `writing-plans` skills
  (`~/.claude/plugins/.../superpowers/6.1.1/skills/`), plus the plan corpus this repo has
  accumulated: `docs/plans/*-design.md` + `*-plan.md` pairs (e.g. HOY-263 goal mode,
  HOY-231/233/234 subagents) and `apps/desktop/docs/superpowers/{specs,plans}/`.

## The two workflows, side by side

**Superpowers = two phases, two artifacts, human gates between.**

1. `brainstorming` → interactive, one question at a time, **propose 2-3 approaches with
   tradeoffs + a recommendation**, present the design in sections with **approval after
   each**, write a **design spec** to `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`,
   self-review, **user review gate**, then hand to writing-plans.
2. `writing-plans` → a **bite-sized TDD plan** to `docs/superpowers/plans/…`: mandatory
   header (Goal / Architecture / Tech Stack / **Global Constraints**), a **File Structure**
   map, per-task **Interfaces (Consumes/Produces — exact signatures)**, steps sized to
   2-5 min each ending in a runnable test, **actual code + exact command + expected output**,
   a No-Placeholders rule, a self-review (spec coverage / placeholder / type consistency),
   and an **execution handoff** (subagent-driven vs inline).

**Hoy plan mode = one turn, one artifact.** Explore read-only (with optional Explore/Plan
subagents), then emit a single `<proposed_plan>` block written to `.hoy/plans/`, surfaced as
a card with **Keep planning / Implement (review each edit) / Implement (auto-approve)**.

## What Hoy already matches (do not "fix")

Hoy's plan mode is a genuinely good implementation of the *writing-plans half*, compressed:

- **Structured output contract.** `PROPOSED_PLAN_FORMAT` ≈ a superpowers plan doc:
  Summary, Key changes (grouped by file, with paths), numbered Steps that "name exact file
  paths and end with a runnable verification", Test plan, Assumptions and risks, Critical
  files. This is the shape HOY-276 asks about, and it's present.
- **No-placeholders discipline.** "no TBD, no 'handle errors appropriately', … leave no
  decision to the implementer" — the same rule writing-plans enforces.
- **Pre-present self-review.** "review the plan for placeholders, contradictions, and
  ambiguity, and resolve any gaps" — the superpowers self-review, inline.
- **Explore-first + subagent delegation.** Trace paths end to end; dispatch read-only
  Explore/Plan subagents in parallel — matches brainstorming's "explore project context"
  and superpowers' subagent posture.
- **Tool-gated to planning.** Writes only to `.hoy/plans/`, bash exploration-only — a hard
  guarantee the plan turn can't implement, which the skills only ask for by convention.
- **A real execution handoff.** The Implement buttons are arguably *better UX* than
  superpowers' "which approach?" text prompt.

Net: Hoy's plan *output* is close to a superpowers *plan*. The gaps are almost entirely on
the **design/brainstorm side** and in **multi-worker execution affordances**.

## Gaps (superpowers has it; Hoy's plan mode doesn't)

1. **No design phase / no spec — the biggest gap.** Superpowers separates *design* (the
   spec: 2-3 approaches, tradeoffs, architecture decisions, chosen approach + why,
   section-by-section approval) from the *step-by-step plan*. Hoy jumps straight to a plan
   in one turn. The design-rationale layer that makes `docs/plans/HOY-263-goal-mode-design.md`
   strong — **"Prior art (studied)"**, **"Alternative considered (deferred) … Rejected for
   v1 because …"**, the hard constraint named with a file:line — is not prompted for.
   `PLAN_MODE_PROMPT` says "Weigh the real tradeoffs and name the one you chose", but that
   produces at most one buried sentence, not a reviewable design with alternatives.

2. **One artifact, not two.** The repo's best planning artifacts are **design + plan
   pairs** (`*-design.md` / `*-plan.md`). Hoy emits a single plan file. The design half —
   the part a human most wants to review and push back on *before* steps get written —
   has no home in Hoy's flow.

3. **No approval gate between design and plan.** Superpowers stops twice for the human
   (approve design → approve spec → then plan). Hoy's only gate is *after* the whole plan
   exists (the card). You can't correct the approach before the plan is fully drafted;
   "Keep planning" re-runs the whole turn instead of iterating on an approved design.

4. **No per-task Interfaces / Global Constraints.** writing-plans gives each task a
   **Consumes/Produces** contract (exact signatures neighbors rely on) and a Global
   Constraints header copied verbatim from the spec. Hoy's format has neither. These matter
   most for **subagent-driven / parallel execution**, where each worker sees only its task —
   and Hoy *has* the subagent infra (HOY-231+) but the plan doesn't feed it structured
   contracts.

5. **Coarser step granularity; no failing-test-first cycle.** writing-plans steps are
   2-5 min each with embedded code and an explicit "write failing test → run → implement →
   run → commit" loop. Hoy's steps are ~a-file-each and name a verification but don't embed
   code or force test-first. *This is a defensible tradeoff* — Hoy optimizes for a concise,
   decision-complete single-turn artifact a human skims — but it's a real divergence worth
   naming rather than silently inheriting.

6. **No subagent-driven execution from the card.** Implement = inline (this session).
   Superpowers also offers "fresh subagent per task + review between". Given HOY-231, a
   "delegate execution task-by-task" option is a natural adopt.

7. **Plan storage is ephemeral + untracked.** Superpowers plans live in committed
   `docs/superpowers/{specs,plans}/`. Hoy writes to `.hoy/plans/` in the project cwd, which
   is **not gitignored and not tracked** (surfaced in HOY-291). For Hoy-the-product this is
   the right default (a user's plans in their own repo), but there's an unresolved tension
   between "durable, reviewable, committed" and "scratch".

## Recommendations (prioritized)

**P1 — Add the design layer.** Two options, not mutually exclusive:
  - *Cheap:* extend `PROPOSED_PLAN_FORMAT` with a required **`## Approaches considered`**
    (2-3, with the chosen one + why) and **`## Design rationale`** (key decisions, named
    constraints) section. Recovers most of the design value with zero flow change.
  - *Fuller:* a two-step plan mode (or a `/design` command): explore → present 2-3
    approaches → **approve** → then draft the plan, emitting a **design doc + plan** pair,
    matching the superpowers two-file split. Uses the existing `ask_question` gate.

**P1 — Resolve `.hoy/` tracking.** Gitignore `.hoy/` (and/or offer "save plan to
`docs/plans/` (tracked)" from the card). Carried from HOY-291.

**P2 — Optional Interfaces block for multi-file plans.** Add per-file/per-task
Consumes/Produces to `PROPOSED_PLAN_FORMAT` when a plan spans 3+ files, so subagent-driven
execution has contracts to hand each worker.

**P2 — Subagent-driven execution option on the Implement card.** A fourth affordance —
"Implement task-by-task (fresh subagent + review)" — riding HOY-231 infra.

**P3 — Plan-document reviewer pass.** Superpowers ships a `plan-document-reviewer-prompt.md`.
A cheap one-shot subagent that checks the drafted plan for placeholders / step-coverage /
type-consistency before the card appears would raise the floor on plan quality.

## Proposed follow-up tickets

1. **Add design rationale to plan mode output** (P1) — extend `PROPOSED_PLAN_FORMAT` with
   `Approaches considered` + `Design rationale`; smallest change, biggest quality lift.
2. **Two-phase plan mode: design → approve → plan** (P1) — the fuller brainstorming parity,
   producing a design+plan pair. Larger; depends on #1's format.
3. **Gitignore `.hoy/` + optional tracked plan location** (P1) — hygiene, shared with HOY-291.
4. **Interfaces + subagent-driven execution for plans** (P2) — Consumes/Produces in the
   format plus a task-by-task execute path on the card, leveraging HOY-231.

## Bottom line

Hoy's plan mode already clears the *plan-document* bar — its output structure, no-placeholder
rule, self-review, and tool gating map cleanly onto superpowers' `writing-plans`. What it's
missing is superpowers' **`brainstorming` half**: a distinct, human-approved *design* with
explicit alternatives and rationale, produced as its own reviewable artifact before the steps
are written. Adopting even the cheap version (P1 #1 — two new required sections) closes most
of the quality gap; the two-phase design→plan flow (P1 #2) closes the rest.
