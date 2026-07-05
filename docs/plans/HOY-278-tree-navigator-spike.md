# `/tree` Navigator — UX Design Spike (HOY-278)

Phase 1, ticket 1 of the Session Tree Navigator epic (HOY-277). This is the
written visual spec the implementation tickets build to: HOY-280 (navigator UI)
and HOY-283 (branch/fork action) are gated on it. Design doc:
`docs/plans/HOY-277-tree-navigator-design.md`. Interactive mockup: the HOY-278
artifact (see the epic).

The spike answers the six questions from the ticket. Each ends with a **Decision**
(what HOY-280/283 build) and, where it matters, an **Alternative considered**.

---

## 0. Grounding: the data and the constraint

`get_tree(sessionId)` returns `SessionTree { tree: SessionTreeNode[]; leafId }`
(`src/lib/types.ts:354-373`, wired in HOY-221). Each node is
`{ entry: SessionEntry; children: SessionTreeNode[]; label?; labelTimestamp? }`,
pre-nested by pi (no `childrenMap` build, unlike `FleetTree`). Entry types
(`types.ts:316-352`): `message`, `model_change`, `thinking_level_change`,
`compaction`, `branch_summary`, `label`, `custom` / `custom_message`,
`session_info`. `leafId` marks the active tip.

**The one hard constraint on rendering fidelity:** a `message` entry carries
pi's `AgentMessage` as `message: unknown` — opaque. So role (user / assistant /
tool), text preview, and tool-call detection are **not** typed off `get_tree`.
HOY-280 must peek into that opaque payload to render message previews, classify
tool nodes, and drive the `no-tools` / `user-only` filters. `get_fork_messages`
(HOY-281) does return typed forkable **user**-message text, so the branch picker
and composer prefill have a typed source even while generic node previews rely on
the peek. This is the single biggest implementation risk in the phase; call it
out in HOY-280's plan.

Reconciliation baseline: `FleetTree` (`src/components/fleet/FleetTree.tsx`) is the
existing recursive tree. Its grammar — `DEPTH_PADDING` (+24px/level, literal
classes for Tailwind), `renderNode(id, depth)`, hover-reveal action rows
(`opacity-0 group-hover:opacity-100 focus-within:opacity-100`), `StatusDot`,
`text-agent` for thread identity, `role="button"` rows — is the vocabulary the
entry-tree extends. Tokens: `src/index.css` (`--brand` ~274 purple, `--agent`
~195 teal, `--ok`, square `--radius: 0`).

---

## 1. Placement

**Decision: a right-side dock rail inside the active `ThreadView`, co-visible
with the transcript (Zed right-dock / outline model).** The transcript stays on
the left; the navigator opens as an `aside` on the right (`border-l`), roughly
320–380px. `ThreadView`'s column becomes `transcript | tree-rail`.

Why co-visible wins here: the product principle is *the transcript is the
product*, and the hero action is *branch from a point you can see*. A right dock
is the only placement where clicking a node can scroll the live transcript to
that entry, and where "Branch from here" can hover-reveal **on the message
itself**. A centered command-palette overlay (`Modal as first thought` is a
product ban) and a full-body view both sever that spatial link.

**Alternative considered — `bodyView: "tree"` (full-body, like `FleetBoard`).**
Cheaper to wire (extend the `bodyView` enum `store.ts:310`, add an `App.tsx:182`
branch) and roomier for genuinely branchy trees, but it replaces the transcript
and loses continuity. **Kept as a documented escape hatch:** a header control in
the rail promotes it to a full-width view reusing the same renderer, for the rare
deeply-branched session. HOY-280 builds the **dock** as primary; the full-body
promotion is optional in Phase 1.

Focus model: opening the rail moves keyboard focus into it (arrow-navigable list,
`Esc` returns focus to the composer and closes). The rail is not a focus trap —
the transcript stays interactive so click-to-scroll works while the rail is open.

**Build it as a reusable right-sidebar host, not a tree-only aside.** The dock is
the first instance of a general right-side sidebar surface (Zed's right-dock
model). A **git tooling panel** (diffs, status, branch ops) is a planned second
tenant. So HOY-280 should build the rail as a host — open/close state, a current-
view identity, and a header with a view-switcher slot — and register the tree as
one view inside it, rather than hard-wiring the aside to the tree. Don't paint the
future git panel into a corner. (The tree's own concerns — filters, node
rendering, the store slice — stay tree-scoped; only the container generalizes.)

---

## 2. Graphical tree language

A **real graphical tree**: a vertical spine with drawn connector lines and elbow
joins at branch points — going beyond `FleetTree`'s padding-only indentation, per
the ticket ("connectors, indentation, node cards, not an ASCII port"). Indent
each branch column by the `DEPTH_PADDING` step so the two trees still rhyme.

Per-entry-type node treatment:

| Entry type | Node treatment |
| --- | --- |
| `message` (user) | Compact row: user glyph + first-line preview (from the peek). Neutral foreground. The primary, branchable node. |
| `message` (assistant) | Assistant glyph + first-line preview. Contained tool calls surface as a muted `· N tools` chip (hidden under the `no-tools` filter) or expandable sub-rows. |
| tool (derived) | Not a distinct entry type — derived from the assistant message payload. Muted mono chip, matching `ToolCall`'s idiom (`ThreadView.tsx:1346`). |
| `compaction` | A full-width horizontal rule node across the spine — `Compacted · {tokensBefore} tokens` — read as a context event, not a message card. |
| `model_change` | Small de-emphasized meta chip on the spine: `→ {modelId}` (mono, muted). |
| `thinking_level_change` | Meta chip: `thinking: {level}` (mono, muted). |
| `label` | A tag pill on its target node (`targetId`). **Read-only in Phase 1**; drives the `Labeled` filter. Writes are HOY-285 (blocked on pi RPC). |
| `branch_summary` | Annotation at a branch point (summary of the diverging line). |
| `session_info` | The origin/root marker of the spine. |

**Active leaf (`leafId`) — unmistakable.** Brand treatment: a filled
`--brand`/70 left bar on the row, a small `active` pill, and a brand ring. This is
pi's `← active`, in Hoy's language. `--brand` (purple), **not** `--agent` (teal),
because teal is reserved (see §4).

**Branch points** (`node.children.length > 1`): the spine splits with elbow
connectors and a fork glyph at the split; each child line indents one
`DEPTH_PADDING` step.

Acceptance (from the ticket): active leaf unmistakable; entry types visually
distinct; branch points read as branch points.

---

## 3. The near-always-linear empty state (the hero)

Most sessions have never branched — the "tree" is a straight vertical spine. So
there is **no "nothing here" empty state**; the spine *is* the content, and the
hero affordance is branching from it.

- Every `message` row hover/focus-reveals a primary **`Branch from here`** control
  (reusing `FleetTree`'s `opacity-0 group-hover:opacity-100 focus-within:opacity-100`
  reveal idiom), placed on the row so the gesture reads as "branch from *this*
  point".
- A one-line header hint sets the invitation:
  **"Branch a new line of thought from any point."**
- Keyboard parity: `↑` / `↓` move a visible row selection; the selected row shows
  its `Branch` action; `Enter` branches, `Esc` closes.

So even a three-message linear session invites exploration. Acceptance: a linear
session still surfaces the branch affordance as the hero, not an empty state.

---

## 4. Two-trees reconciliation

Two trees exist and stay structurally distinct: the **entry tree** (within one
thread, from `get_tree`) and the **FleetTree** (threads across the workspace).
They meet only at fork points. Reconciliation is visual + copy, not structural
(no merged graph — that's out of scope in the epic).

- **Copy discipline.** Within-thread structure is *entries* / *the conversation* /
  *points*; cross-thread structure is *threads* / *branches*. The action verb is
  **Branch**, and it always produces a new thread.
- **The teal join rule.** Entry-tree rows use the FleetTree grammar but reserve
  `--agent` teal **exclusively** for the cross-link: a node that has been branched
  into a child thread shows a teal **`→ {thread title}`** chip that opens that
  thread (which lives in the FleetTree/sidebar). Teal therefore *always* means
  "a thread lives here," in both trees. Entry nodes themselves are neutral; the
  active leaf is brand-purple. This is what makes the two trees legible as one
  system with a single join rule.
- **Branch action shape — one affordance in Phase 1.** The design doc offers
  "new thread" vs "fork in place" vs both. **Decision: the single primary
  affordance is "Branch to new thread"** — run `fork(entryId)` producing a new
  session file surfaced as a child thread (`parentThreadId` = source), source
  untouched. It matches Hoy's model (a thread *is* one file), keeps the
  entry-point ↔ FleetTree-node mapping one-to-one, and is the cleanest mental
  model (git-branch-like). **"Fork in place"** (repoint the current thread's own
  sidecar via `session_start`) is **deferred** — same RPC plumbing, but the
  "where did my conversation go?" surprise isn't worth it in Phase 1. Noted for a
  later ticket, not built now.

---

## 5. Click + continuity

- **Click a node → scroll the transcript** (co-visible, left) to that entry, with
  a brief highlight flash. No inline preview is needed — the transcript is right
  there. This is the payoff of the dock placement (§1).
- **After branching → open the new child thread** (focus moves to it; the user
  branched in order to explore it), with a subtle toast **"Branched to
  {title}"**. The source thread is one click away in the sidebar/FleetTree and is
  intact.
- **If the branched entry is a user message, prefill the composer** with its text
  (pi's `/fork` behavior; typed source is `get_fork_messages`, HOY-281) so the
  user can immediately redirect the new line.

---

## 6. Discoverability & controls

- **`/tree` slash command.** Add to `SLASH_BUILTINS` (`src/components/Composer.tsx:62`,
  `source: "hoy"`) for autocomplete; intercept in `submitPrompt`
  (`src/state/store.ts:1267`, mirroring the `/compact` block `:1285`) so it toggles
  the rail and never round-trips to pi.
- **Keybinding.** Propose `Cmd/Ctrl+Shift+Y` — the fork "Y" is the mnemonic and it
  is collision-light. *Confirm no existing binding collides before wiring
  (open question).*
- **Header button.** An optional git-branch/tree icon toggle in the `ThreadView`
  header, alongside Full Screen / Close, for discoverability.
- **Filter modes — a real segmented control** at the top of the rail:
  `Default · No tools · User · Labeled · All`. Pure client-side over the fetched
  tree (`get_tree` returns types and `node.label`); **not** pi's hidden `Ctrl+O`
  cycle. `no-tools` / `user-only` depend on the message peek (§0).
- **Labels.** Rendered read-only as tag pills; drive the `Labeled` filter. Writes
  deferred (HOY-285).

---

## Impl handoff notes (for HOY-279 / 280 / 283)

- **HOY-279 (store slice):** per-thread `sessionTree` record mirroring
  `slashCommands` / `stats` (`store.ts`); fetch `getTree(thread.sessionId)` on rail
  open, gated on a live `sessionId` (cf. `refreshSlashCommands` `store.ts:1531`);
  refresh on turn `done` and on `leafId` change; scope subscriptions with
  `useShallow` (the FleetTree pattern) so streaming deltas don't re-render the
  tree.
- **HOY-280 (UI):** recursive renderer over `SessionTreeNode.children` with drawn
  connectors; the message peek (§0) is the gating unknown — spike it first.
  Filters are client-side. Reuse `Message`/`MessageContent`/`MessageResponse`
  (`ai-elements/message.tsx`) and `Tool`/`ToolHeader` (`ai-elements/tool.tsx`) for
  previews where practical; match `FleetTree`'s row idiom.
- **HOY-283 (action):** "Branch to new thread" via the `spawnChildThread` /
  `acquireSession` path (`store.ts`) → `fork` (HOY-281) → new thread with
  `parentThreadId` = source; apply the §5 focus/toast/prefill behavior.

## Open questions

1. **Keybinding collision** for `Cmd/Ctrl+Shift+Y` — verify against the existing
   handlers before wiring.
2. **Message peek shape** — confirm the opaque `AgentMessage` reliably exposes
   role + first-line text + tool-use blocks for previews and the tool/user
   filters; if not, `no-tools`/`user-only` may ship degraded in Phase 1.
3. **Rail width vs branchy trees** — validate the 320–380px dock on a real
   multi-branch session; if it's tight, ship the full-body promotion (§1
   alternative) in Phase 1 rather than deferring it.
