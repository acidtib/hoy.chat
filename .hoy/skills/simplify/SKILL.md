---
name: simplify
description: "Simplify code without changing behavior: remove indirection, duplication, and dead paths. Use when asked to simplify, clean up, or reduce complexity."
user-invocable: true
argument-hint: "[file paths]"
---

# Simplify

Make the target code smaller and easier to follow while keeping behavior identical.

## Workflow

1. **Scope and baseline.** Read the target fully. Run its tests first so you have a green baseline to protect.
2. **Cut in this order:** dead code and unreachable branches, duplicated logic worth one helper, needless indirection (wrappers called once, pass-through layers), convoluted control flow that a straight-line version replaces, over-general abstractions serving one caller.
3. **Keep behavior identical.** No feature changes, no API changes, no "while I am here" refactors. When two paths look equivalent, check before merging them.
4. **Verify.** Re-run the tests (plus typecheck/lint when the repo has them) and diff the result against the baseline run. Report what was removed and the check results.

## Rules

- Prefer deletion over rewriting. The best simplification removes code without adding any.
- Do not change names broadly; rename only when the old name actively misleads.
- Stop when further cuts trade clarity for cleverness. Shorter is not simpler if it is harder to read.
