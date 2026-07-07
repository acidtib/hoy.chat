# HOY-329: Filter subagent threads out of home recent thread list

**Goal:** Prevent subagent threads (threads with a non-null `parentThreadId`) from appearing in the home screen's "Recent" section.

**Architecture:** The `HomePage` component computes its recents by flat-mapping all non-archived threads across all projects, then sorting by `updatedAt` and capping at 6. The only existing filter is `!t.archived`. Adding `!t.parentThreadId` brings it in line with the sidebar, which already uses the same predicate.

**Tech Stack:** `HomePage.tsx` (React component reading from Zustand store).

## Approaches considered
Only one reasonable approach: add `!t.parentThreadId` to the filter at `apps/desktop/src/components/HomePage.tsx:35`. The sidebar already uses the identical inline predicate (Sidebar.tsx:83, 256), so this is purely matching established convention.

## Design rationale

The sidebar and fleet view already exclude subagent children from root-thread lists using `.filter((t) => !t.parentThreadId)`. The `HomePage` recents computation was simply missed when `HOY-250` established the rule that subagent children "never render as rows" in top-level thread lists. Using `!t.parentThreadId` inline (not the `isSubagentThread` helper from `delivery.ts`) keeps the filter identical to the sidebar's, without introducing an import dependency `HomePage.tsx` does not currently have.

## Key changes

- **`apps/desktop/src/components/HomePage.tsx:35`** — add `&& !t.parentThreadId` to the existing `.filter((t) => !t.archived)` call in the `recents` useMemo.

## Steps

1. Edit `apps/desktop/src/components/HomePage.tsx:35`:
   Change:
   ```
   .filter((t) => !t.archived)
   ```
   To:
   ```
   .filter((t) => !t.archived && !t.parentThreadId)
   ```
   Verify: `bun run check:ts` passes; visually confirm subagent threads no longer appear in the home recents section after spawning a child.

## Test plan

- Run `bun run check:ts` — TypeScript compilation must pass.
- If there are existing tests for HomePage or the recents computation, run `bun test`. (Explore showed no dedicated HomePage test; the check is sufficient.)

## Assumptions and risks

- **Assumption:** `parentThreadId` is `null` for root threads and `undefined` for untracked threads. The `??` check `!t.parentThreadId` covers both `null` and `undefined` because `!!null === false` and `!!undefined === false`. No risk of a falsy collision (empty string is not a valid parentThreadId value).
- **Risk:** None. This is a backward-compatible additive filter that only removes items from a list.

## Critical files

- `apps/desktop/src/components/HomePage.tsx`
