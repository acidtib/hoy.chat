# HOY-293 — AI Elements Audit: Hoy Desktop vs. Upstream

Audit of our `apps/desktop/src/components/ai-elements/*` against the upstream
"AI Elements" library (Vercel AI SDK Elements). Captured 2026-07-04.

## 1. Upstream catalog (authoritative)

Source of truth: the live registry manifest
`https://elements.ai-sdk.dev/api/registry/registry.json` (48 components),
cross-checked against `registry.ai-sdk.dev/all.json` and individual
`/components/*` doc pages, current as of July 2026.

Note: several components from older AI Elements docs (**Response, Actions,
Branch, Source, Loader**) are **no longer standalone registry entries** —
`/components/response` 404s and `/components/loader` 308-redirects to shadcn's
Spinner. They have been folded into `message` (Response/Actions/Branch),
renamed (`source` → `sources`), or dropped (`loader` → shimmer/spinner).

The 48 current components:

| Component | One-line description |
|---|---|
| **agent** | Agent-run container / agent status surface. |
| **artifact** | Container for AI-generated content with header, actions, and close. |
| **attachments** | Composable display of file/image/video/audio/source attachments (preview, info, remove, hover card). |
| **audio-player** | Playback UI for generated/streamed audio. |
| **canvas** | ReactFlow-based node/edge canvas with zoom/pan. |
| **chain-of-thought** | Step-by-step reasoning visualization (header, step, search results, content, image). |
| **checkpoint** | Compact marker to flag/navigate important moments in a workflow. |
| **code-block** | Syntax-highlighted code with copy button and light/dark themes. |
| **commit** | Git commit display. |
| **confirmation** | Tool approval/rejection UI with request + response (accept/reject) states. |
| **connection** | Custom SVG connection line for flow diagrams. |
| **context** | Token-usage / context-window / cost breakdown via hover card + progress. |
| **controls** | Zoom/pan control buttons for canvas. |
| **conversation** | Sticky-to-bottom message container with scroll-to-latest. |
| **edge** | Custom ReactFlow edge types (temporary/animated). |
| **environment-variables** | Env var key/value display + management. |
| **file-tree** | Collapsible file/directory tree. |
| **image** | Renders AI-generated images from base64/uint8Array. |
| **inline-citation** | Badge-based inline citations with a source carousel. |
| **jsx-preview** | Live preview of generated JSX. |
| **message** | Chat message container (user/assistant roles) incl. branching, actions, response body, attachments. |
| **mic-selector** | Microphone input device picker. |
| **model-selector** | Command-palette dropdown to pick a model, with provider logos. |
| **node** | Card-based flow-diagram node with handles. |
| **open-in-chat** | Dropdown to share content to ChatGPT/Claude/v0/etc. |
| **package-info** | npm/package metadata card. |
| **panel** | Styled ReactFlow panel container. |
| **persona** | Assistant persona/identity display. |
| **plan** | Collapsible card for AI-generated plans with shimmer title. |
| **prompt-input** | Full composer: textarea, attachments, action menu, toolbar, model select, submit with status. |
| **queue** | Queued messages/tasks display. |
| **reasoning** | Collapsible reasoning stream; auto-opens while streaming, closes when done. |
| **sandbox** | Code sandbox execution surface. |
| **schema-display** | Renders a JSON/data schema. |
| **shimmer** | Text shimmer animation for streaming/loading states. |
| **snippet** | Small copyable code/command snippet. |
| **sources** | Collapsible list of sources/citations used for a response. |
| **speech-input** | Voice/speech-to-text input. |
| **stack-trace** | Formatted error stack trace. |
| **suggestion** | Horizontal row of clickable starter suggestions. |
| **task** | Collapsible task list for workflow progress, with status + file refs. |
| **terminal** | Terminal output display. |
| **test-results** | Test run results (pass/fail) display. |
| **tool** | Collapsible tool call (header/input/output) with status badges incl. approval states. |
| **toolbar** | Canvas/editor toolbar. |
| **transcription** | Transcript display for audio. |
| **voice-selector** | TTS voice picker. |
| **web-preview** | Embedded preview of a URL/web page. |

## 2. Coverage table

We have 8 files, mapping to 8 upstream primitives. Everything else is missing.

| Upstream | Status | Our file | Notes on divergence |
|---|---|---|---|
| code-block | **Have (adapted)** | `code-block.tsx` | Custom fine-grained Shiki core bundle (json/ts/diff, one-light/one-dark-pro only) for bundle size. `CodeBlock` + `CodeBlockCopyButton`. No line-highlight/filename-header extras. |
| conversation | **Have (adapted)** | `conversation.tsx` | `Conversation`/`Content`/`EmptyState`/`ScrollButton`. Tuned `initial="instant"` (HOY-271). On par. |
| message | **Have (heavily adapted)** | `message.tsx` | Folds in consolidated upstream pieces: `MessageResponse` (= Response, via Streamdown, memoized), `MessageActions`/`MessageAction` (= Actions), `MessageBranch*` (= Branch), `MessageAttachment(s)` (partial of `attachments`), plus custom `MessageToolbar`. Attachment piece lighter than full `attachments` (no hover-card, no video/audio, no grid/list/inline variants). |
| model-selector | **Have (vendored)** | `model-selector.tsx` | Command-palette variant with provider logos from models.dev. On par. |
| plan | **Have (vendored)** | `plan.tsx` | Vendored as-is (HOY-259): Collapsible+Card with header/title/description/action/content/footer/trigger + shimmer title. On par. |
| reasoning | **Have (adapted)** | `reasoning.tsx` | Adds live `elapsed` "Thinking for Ns" ticker (HOY-211), `autoCloseOnStreamEnd`, and a perf fix rendering streaming text as plain preformatted text (HOY-258). Behaviorally ahead of upstream. |
| shimmer | **Have (vendored)** | `shimmer.tsx` | Motion-based text shimmer. On par. (Upstream `loader` now redirects to shadcn Spinner; shimmer is our loading primitive.) |
| tool | **Have (adapted)** | `tool.tsx` | `Tool`/`Header`/`Content`/`Input`/`Output`. Zed-style: completed tools render bare (no badge). Recognizes all 7 states incl. approval states, **but has no interactive accept/reject UI** — that lives in the separate `confirmation` component we don't have. (HOY-288 added a non-collapsible header mode.) |

## 3. Gaps

**Consolidated pieces we already cover well:** Response, Actions, Branch handled
inside `message.tsx`; `sources`/`source` we do not cover.

**Sub-component / prop gaps in what we adapted:**
- **tool** — no interactive tool-approval controls. We show approval *states*
  but can't render accept/reject buttons; upstream splits this into
  `confirmation`. Most important gap for an agent app.
- **message attachments** — our `MessageAttachment` covers image + generic file
  only. Upstream `attachments` adds video/audio previews, hover-card enlarge,
  and grid/inline/list variants.
- **code-block** — no filename header or per-line highlight support
  (intentional trim).

**Components we lack entirely (40).** Grouped by relevance to a chat/agent
desktop app:

- *High-value for Hoy:* `confirmation`, `task`, `sources`, `inline-citation`,
  `context`, `suggestion`, `attachments` (full), `chain-of-thought`, `image`,
  `web-preview`, `artifact`, `checkpoint`, `queue`, `open-in-chat`, `persona`.
  (`prompt-input` is upstream's composer — Hoy maintains its own Zed-parity
  composer, so treat it as reference, not something to vendor.)
- *Coding-agent surfaces:* `file-tree`, `terminal`, `stack-trace`,
  `test-results`, `snippet`, `commit`, `sandbox`, `schema-display`,
  `environment-variables`, `package-info`, `jsx-preview`, `agent`.
- *Voice/audio (low relevance today):* `audio-player`, `speech-input`,
  `transcription`, `mic-selector`, `voice-selector`.
- *Flow-diagram / ReactFlow (not relevant to a transcript UI):* `canvas`,
  `node`, `edge`, `connection`, `controls`, `panel`, `toolbar`.

## 4. Prioritized recommendations

Ranked by value to Hoy's transcript/agent surface. Size = rough adoption effort
(S ≤ ~1 file straight vendor, M = vendor + wire into ThreadView, L = new
subsystem).

1. **confirmation** — **S/M.** Highest priority: our `tool` recognizes
   `approval-requested` but can't render accept/reject. An agent that runs tools
   needs an inline approval gate; this closes a real hole, not just polish.
2. **task** — **S/M.** Agents emit todo/plan-progress lists; a collapsible
   status list with file refs is the natural render target and complements
   `plan`.
3. **sources** + **inline-citation** — **M.** Once the agent does web/file
   search, cited answers need a sources drawer and inline citation chips.
4. **context** — **S.** Token-usage/cost/context-window meter — cheap,
   high-signal for a desktop app where users watch long agent runs and spend.
5. **suggestion** — **S.** Starter-prompt chips for the empty conversation state
   (we already have `ConversationEmptyState` to host them).
6. **attachments (full)** — **S/M.** Upgrade `MessageAttachment` to the full
   component for video/audio/hover-card previews as attachment types broaden.
7. **image** — **S.** Straightforward render path for model-generated images.
8. **chain-of-thought** — **M.** Alternative structured reasoning view; lower
   priority since our adapted `reasoning` already handles streaming thoughts.
9. **web-preview** / **artifact** — **M/L.** Valuable when Hoy produces rich
   artifacts or previews URLs; defer until that surface exists.
10. **Coding-agent set** (`file-tree`, `terminal`, `stack-trace`,
    `test-results`, `snippet`, diff) — **M each, batch later.** Adopt as a group
    if/when Hoy leans into coding-agent workflows.
11. **Skip for now:** all ReactFlow/canvas components and the voice/audio set —
    no fit with the current chat transcript UI.

## Suggested follow-up tickets

- **confirmation component** — inline tool accept/reject gate (unblocks the
  `approval-requested` state `tool.tsx` already models).
- **task component** — render agent todo/progress lists.
- **sources + inline-citation** — cited-answer rendering for search results.
- **context meter** — token/cost/context-window usage surface.
- **suggestion chips** — starter prompts in the empty conversation state.
