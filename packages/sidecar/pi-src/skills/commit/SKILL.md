---
name: commit
description: Stage and commit the current change with a Conventional Commit message. Use when asked to commit, save, or checkpoint work.
user-invocable: true
---

# Commit

Turn the current working tree change into one clean commit.

## Workflow

1. **Inspect.** `git status --short` and `git diff` to see exactly what would be committed. If the tree mixes unrelated changes, stage only the coherent subset and say what is left out.
2. **Check the message convention.** Read AGENTS.md (or recent `git log --oneline`) for the repo's commit style. Default to Conventional Commits: `type(scope): lowercase description, no trailing period`. Types: `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `build`, `ci`, `chore`.
3. **Verify before committing.** Run the fastest relevant check (tests, typecheck, lint) for the touched area. Never commit secrets, `.env` files, or credentials.
4. **Commit, then report.** Commit with the message and report the short hash plus a one-line summary. Never push, amend other commits, or rewrite history unless explicitly asked.

## Rules

- One commit per logical change. Do not bundle unrelated work to save a round trip.
- No co-author trailers and no tool attribution lines in the message.
- If the working tree is empty, say so instead of creating an empty commit.
- Never use destructive commands (`reset --hard`, `checkout --`, force push) during this flow.
