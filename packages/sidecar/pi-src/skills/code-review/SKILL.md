---
name: code-review
description: Review a change or branch for correctness, security, and maintainability. Use when asked to review code, a commit, a PR, or a diff.
user-invocable: true
argument-hint: "[commit, branch, or file paths]"
---

# Code review

Review the change the user points at (working tree, commit range, branch, or file list). If they point at nothing, review the uncommitted working tree.

## Workflow

1. **Scope the change.** `git status --short` and `git diff` (or `git log` for a range) to see what is under review. Read the full diff before judging any single hunk.
2. **Understand intent.** Read the surrounding code and any linked context (issue, PR description, comments) so feedback targets what the change tries to do.
3. **Evaluate in this order:** correctness (bugs, edge cases, broken invariants), security (injection, auth, secrets, unsafe deserialization), then maintainability (naming, structure, dead code, missing tests).
4. **Verify claims.** Do not flag what you have not checked. Read the called code, run the relevant tests or typecheck when cheap, and quote file:line evidence for real problems.

## Report shape

- One verdict line first: approve, approve with nits, or needs changes.
- Blocking issues first, each with file:line, why it matters, and a concrete fix or a question when intent is unclear.
- Nits and suggestions after, kept short. Skip praise paragraphs and generic checklist filler.
- Do not rewrite the change yourself unless asked. Small suggested diffs are fine inside the report.
