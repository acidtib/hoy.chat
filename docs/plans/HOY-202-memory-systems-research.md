# HOY-202: Competitor memory systems research

Research-only spike. How shipping coding agents persist knowledge across sessions,
and a recommendation for whether and how Hoy should add a memory system. No code
changes in this ticket.

Reviewed 2026-06-30 against current vendor docs and public captures. Pi version
note: the ticket text says 0.78, but the repo pins Pi 0.80.2 (CLAUDE.md, sidecar
payload). Treat 0.80.2 as authoritative; the SDK seams cited below
(`extensionFactories`, resource loader, per-turn hooks) are stable across that
range, so the version gap does not change the recommendation.

## The two-channel pattern (what everyone converged on)

Every mature agent separates durable knowledge into two channels:

1. **User-authored, git-able instructions.** A markdown file (or files) the user
   writes and version-controls: CLAUDE.md, AGENTS.md, `.cursor/rules`,
   `.windsurf/rules`. Always in context. This is Hoy's CLAUDE.md analogue and it
   already exists at the project level.
2. **Agent-authored memory.** Notes the agent writes for itself from the
   conversation (corrections, build commands, discovered facts), recalled in
   later sessions. This is the piece Hoy does not have.

The interesting design space, and the subject of this ticket, is channel 2. The
market has NOT converged there: storage, write trigger, approval UX, and recall
strategy all differ, and one vendor (Cursor) shipped auto-memory then pulled it.

## Comparison

| System | Agent-memory store | Scope | Write path | Approval UX | Read path | Notable |
|---|---|---|---|---|---|---|
| **Windsurf Cascade** | `~/.codeium/windsurf/memories/` (local files) | Per-workspace | `create_memory` tool, auto or on user request ("create a memory of...") | None; saved silently | Auto-retrieved when Cascade judges relevant | Sentence-length notes, not transcripts; free (no credits); prompt-injection persistence risk documented |
| **Claude Code** | `~/.claude/projects/<project>/memory/` with `MEMORY.md` index + one-fact-per-file topic files with frontmatter | Per-repo (shared across worktrees), machine-local | Agent-initiated during session ("Writing memory"); also user "remember that..." | Silent; plain-markdown, user audits/edits via `/memory` | `MEMORY.md` index injected every session (first 200 lines / 25KB); topic files read on demand | Cleanest separation of user (CLAUDE.md) vs auto (memory dir); index-plus-recall keeps startup cost bounded |
| **Cursor** | "Memories" (rules auto-generated from chats), managed in Settings | Per-project, per-user | Auto-generated from conversations; required privacy mode off | User-reviewable in Settings | Injected as rules | REMOVED in 2.1.x; users told to export and convert to Rules. Cautionary tale: auto-rules were noisy/low-signal enough to cut |
| **opencode** | No built-in agent memory | n/a | n/a (AGENTS.md is user-authored only) | n/a | AGENTS.md always in context; global `~/.config/opencode/AGENTS.md` + project | Relies on AGENTS.md + third-party plugins (Letta-style memory blocks, Hindsight, memories.sh MCP) for the memory layer |
| **Codex CLI** | No agent-written memory; `prefix_rule` persists approvals | n/a for knowledge | AGENTS.md user-authored; `prefix_rule` proposed during escalation, user-accepted | `prefix_rule` reviewed at accept time | AGENTS.md concatenated root-down; `~/.codex/AGENTS.md` global | Transcripts persisted for `resume`; the durable channel is AGENTS.md, not agent memory |

Takeaways:

- **File-based beats database** for this class of tool. Every survivor uses plain
  markdown on disk: human-readable, git-able, trivially auditable and deletable.
  No one who ships a desktop coding agent runs a memory DB for this; the DB
  approaches are third-party add-ons (Letta, Hindsight, memories.sh).
- **Claude Code's index-plus-topic-files is the strongest design.** A small always-
  loaded `MEMORY.md` index plus lazily-read topic files bounds the per-session
  token cost while keeping recall broad. Windsurf's "retrieve when relevant" is
  more magic but less inspectable.
- **Cursor's removal is the warning.** Fully-automatic, silent memory generation
  produced enough low-signal noise that they killed the feature and pushed users
  back to explicit Rules. Whatever Hoy ships must bias toward high-signal writes
  and easy pruning, not "create memories liberally."
- **Two vendors (opencode, Codex) ship no agent memory at all** and lean entirely
  on the user-authored file. That is a legitimate, low-risk baseline; a Hoy
  memory feature has to clearly beat "just edit your project instructions."

## Answers to the ticket questions

### 1. Storage: file-based vs database, scope, location

File-based markdown, not a database. Match the branding-isolation decision in
CLAUDE.md and the Claude Code layout Hoy already mirrors.

- **Project-scoped** memories are the primary win for a coding agent (facts about
  *this* codebase). Store them in the branded project dir landing in HOY-222:
  `<project>/.hoy/memory/` with a `MEMORY.md` index plus topic files. Project-
  scoped means they live with the repo and can be committed if the team wants.
- Optionally a **global** tier later in `~/.hoy/agent/memory/` for cross-project
  user preferences, mirroring `~/.claude/CLAUDE.md`. Defer to keep v1 small.
- Do not invent a parallel store. This reuses the same dir Pi's resource loader
  and trust manager already key off (`.hoy/` after HOY-222), so memories sit next
  to `settings.json`, `skills/`, `prompts/`.

### 2. Write path and approval UX

Three possible triggers, in increasing autonomy:

- **User command** ("remember that ..."): lowest risk, highest signal. Ship first.
- **Agent-initiated tool** (a `create_memory`-style custom tool the model calls):
  the powerful option, and the natural Pi fit (see Q4). Ship gated.
- End-of-session summarization: defer; it is the noisiest and hardest to keep
  high-signal.

Approval UX: reuse Hoy's existing permission-gate card. Hoy already renders Pi
`extension_ui_request` as a `PermissionRequest` card (see `docs/pi-rpc-coverage.md`,
`classify_extension_ui`). A memory-write tool gated exactly like `edit`/`write`
gives the user a card showing the proposed memory text with allow/deny, which is
strictly better than Windsurf's silent writes and avoids the Cursor noise problem.
This is the recommended UX: card on write, not silent, not a passive badge.

### 3. Read path and token cost

Inject an **index**, recall the rest. Follow Claude Code: load a concise
`MEMORY.md` (cap it, for example first ~200 lines) into the system prompt each
session via Pi's `systemPromptOverride`/append seam or a per-turn hook; let the
model pull individual topic files on demand through the normal read-file tool.
This bounds startup token cost to the index size regardless of how much memory
accumulates. Always-inject-everything does not scale; pure semantic retrieval
needs an embedding store we do not want to run. Index-plus-lazy-read is the
proven middle path.

### 4. Fit with Pi

Both halves fit Pi's SDK cleanly and match how Hoy's sidecar is already wired.

- **Write tool as a Pi custom tool via `extensionFactories`.** The sidecar already
  passes `extensionFactories: [createHoyPermissions(...)]`
  (`sidecar/pi-src/hoy-sidecar.ts`). A `createHoyMemory(...)` factory registering
  a `remember`/`create_memory` tool drops into the same array. It writes to
  `<project>/.hoy/memory/`, and because unknown tools already route through the
  permission gate, the write is gated for free (the same fail-safe posture noted
  in HOY-228). This is the already-working in-process path, no jiti/disk-discovery
  risk.
- **Recall injection.** Pi exposes lifecycle hooks (the `before_agent_start`-style
  seam referenced in the ticket) plus `systemPromptOverride`. Injecting the
  `MEMORY.md` index at session start via the system-prompt override we already
  control is the simplest first cut; a per-turn hook is the richer option if
  per-turn recall is wanted later. Confirm the exact hook name against the pinned
  0.80.2 SDK during implementation; conceptually both halves are supported.
- This keeps the architecture intact: no AI SDK, no in-process agent logic in
  Rust/TS, memory is just a Pi extension plus a prompt-injection seam.

### 5. Privacy

- **Never write:** API keys, `auth.json` contents, OAuth tokens, anything
  Hoy already keeps out of the renderer (CLAUDE.md credential-isolation rule).
  The write tool must refuse obvious secret shapes and the gate card lets the user
  catch the rest before anything lands on disk.
- **Inspect/delete:** plain markdown in `<project>/.hoy/memory/`. Give the
  MemoryPanel (`src/components/panels.tsx`, today mostly mock UI) a real list of
  memory files with open-in-editor and delete, mirroring Claude Code's `/memory`.
  Because it is files, "delete a memory" is just removing a file; no DB migration.
- Prompt-injection persistence is a real risk (the Windsurf SpAIware writeup):
  content read from a repo could instruct the agent to write a malicious memory
  that persists across sessions. The write-gate card is the mitigation; do not
  auto-approve memory writes.

## Recommendation

Build a memory system, file-based, closely modeled on Claude Code, delivered as a
Pi extension. It fits Hoy's architecture with zero new infrastructure and clearly
beats the "just edit project instructions" baseline that opencode/Codex settle
for, while avoiding the silent-noise trap that made Cursor pull theirs.

Design in one line: project-scoped markdown memories in `<project>/.hoy/memory/`
with a `MEMORY.md` index, written by a gated Pi custom tool (card like edit/write),
recalled by injecting the index at session start and lazy-reading topic files.

Non-goals for v1: global/cross-project tier, end-of-session auto-summarization,
embedding-based retrieval, a memory database. Each can layer on later without
rework because the store is just files.

### Rough MVP milestone cut

1. **Store + read.** Define `<project>/.hoy/memory/` layout (`MEMORY.md` index +
   topic files, frontmatter: name/description/type). Inject the capped index into
   the session via the existing `systemPromptOverride` seam. Model can already
   read topic files with its normal file tools. Ships value immediately: users can
   hand-author memories and the agent recalls them.
2. **Gated write tool.** `createHoyMemory` extension factory registering a
   `remember` tool that appends a fact and updates the index, routed through the
   existing permission gate so each write shows an allow/deny card. Add the
   secret-shape refusal. Covers both "remember that ..." and agent-initiated writes
   with one tool.
3. **Manage UX.** Turn the mock MemoryPanel into a real list of memory files with
   open and delete. This is the inspect/delete privacy requirement and closes the
   loop.
4. **Later (separate tickets):** global tier in `~/.hoy/agent/memory/`, optional
   end-of-turn summarization suggestion, per-turn recall hook if session-start
   injection proves insufficient.

Dependency note: the store path assumes the `.pi` -> `.hoy` project-dir rebrand
(HOY-222). Land that first, or key v1 off whatever the current project config dir
is and move with HOY-222.

## Sources

- [Windsurf/Cascade Memories docs](https://docs.devin.ai/desktop/cascade/memories) (redirected from docs.windsurf.com)
- [Windsurf memories overview (Arsturn)](https://www.arsturn.com/blog/understanding-windsurf-memories-system-persistent-context)
- [Windsurf SpAIware persistent prompt-injection exploit (Embrace The Red)](https://embracethered.com/blog/posts/2025/windsurf-spaiware-exploit-persistent-prompt-injection/)
- [Claude Code memory docs](https://code.claude.com/docs/en/memory)
- [Cursor Rules docs](https://cursor.com/docs/rules)
- [Cursor Rules vs Memories (community forum)](https://forum.cursor.com/t/rules-vs-memories-and-project/137149)
- [opencode Rules docs](https://opencode.ai/docs/rules/)
- [opencode-agent-memory (Letta-style blocks)](https://github.com/joshuadavidthomas/opencode-agent-memory)
- [Codex AGENTS.md guide](https://developers.openai.com/codex/guides/agents-md)
- [Codex Rules and prefix_rule](https://developers.openai.com/codex/rules)
