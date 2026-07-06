# HOY-322: Skills UX spike

Timeboxed spike. Question: what does Hoy have to build to make Pi's **skills**
(the [Agent Skills standard](https://agentskills.io)) a first-class feature in
the desktop app? Two sub-questions:

1. How does a skill **invocation** surface in the RPC event stream we consume?
2. What is the **management / install** surface, and how much of it does Pi give
   us for free?

Verified against the pinned Pi (`@earendil-works/pi-coding-agent` 0.80.3) in
`packages/sidecar/pi-src/node_modules`.

## What a skill is

A skill is a `SKILL.md` (or a plain `.md`) with YAML frontmatter:

```yaml
name: my-skill            # [a-z0-9-], <= 64 chars, no leading/trailing/double hyphen
description: when to use   # <= 1024 chars
disable-model-invocation: false   # optional
```

`loadSkills({ cwd, agentDir, skillPaths, includeDefaults })`
(`core/skills.js`) discovers them from, in order: explicit `skillPaths`, the
project dir (`cwd` → `.hoy/skills` after the HOY-222 branding), and the global
agent dir (`agentDir` → `~/.hoy/skills`, dev `~/.hoyd/skills`). Discovery rule:
a directory containing `SKILL.md` is a skill root (no recursion past it);
otherwise direct `.md` children are loaded, and subdirs are searched for
`SKILL.md`. Returns `{ skills, diagnostics }` — diagnostics carry per-skill
validation errors (`resourceType: "skill"`).

`Skill` shape (`core/skills.d.ts`): `{ name, description, filePath, baseDir,
sourceInfo, disableModelInvocation }`.

## How a skill reaches the model (two paths)

### 1. Model auto-invocation
`formatSkillsForPrompt(skills)` emits an XML block (per the agentskills.io
standard) of every skill's name + description into the **system prompt**. Skills
with `disable-model-invocation: true` are excluded here. When a description
matches the task, the model **reads the `SKILL.md`** to pull in the body.

Over our RPC that surfaces as an ordinary `Read` tool call on the skill's path.
Pi even classifies it: `tools/read.js:76` tags a read whose path is a skill file
as `kind: "skill"`.

### 2. Explicit `/skill:name [args]`
`_expandSkillCommand(text)` (`agent-session.js:886`) intercepts a user turn
starting with `/skill:`. It reads the skill file, strips frontmatter, and
**rewrites the user message text** into:

```
<skill name="<name>" location="<filePath>">
References are relative to <baseDir>.

<body>
</skill>

<optional user args>
```

(`agent-session.js:898`.) So the invocation is **not a distinct event** — it is
a normal user message whose text carries a `<skill>` block.

## Central finding: rendering

**A skill invocation is not its own RPC event.** It arrives as (1) a `Read` tool
call, or (2) a user message containing a `<skill …>…</skill>` block. Our
transcript renderer today would print that raw XML in the user's own bubble.

Pi solves this by parsing the block back out:

```js
// agent-session.js:41 — one regex, portable as-is
parseSkillBlock(text) => { name, location, content, userMessage } | null
```

Its TUI renders the result as a collapsed `[skill] <name>` chip that expands to
the body (`modes/interactive/components/skill-invocation-message.js`), and the
HTML exporter does the same (`core/export-html/template.js:321,1187`). Hoy's
renderer needs the equivalent: detect the `<skill>`-block user message via
`parseSkillBlock`, render a `[skill] <name>` chip (collapsed by default,
expandable to `content`), and render `userMessage` (if any) as the actual user
text below it.

This is the one genuine code gap the spike surfaces. It is small (a regex + a
transcript special-case), but without it the feature looks broken.

## Already working (don't rebuild)

- **Discovery inside the compiled sidecar** — proven by the HOY-228 spike
  (`docs/plans/HOY-228-disk-extension-findings.md`): `getSkills()` returns skills
  from the branded dir. Skills are plain markdown, so unlike disk `.ts`
  extensions they need no jiti/typebox.
- **`/skill:<name>` autocomplete** — `get_commands` returns skills with
  `source: "skill"` (`agent-session.js:1760`), wired into the composer's `/`
  picker (HOY-223) and the `@` Commands category (HOY-286). The composer already
  strips the `skill:` prefix for display and inserts the full `/skill:<name>`.

## Gaps → what the feature ticket owns

1. **Transcript rendering** of `<skill>` blocks (parseSkillBlock port + chip).
   Do this first; it is what otherwise leaks raw XML.
2. **Management panel** — list installed skills (name, description, source:
   global vs project vs extension, diagnostics), enable/disable
   (`disable-model-invocation`), open the file. Data is `getSkills()` /
   `loadSkills` output; no new Pi surface needed, but we need an RPC command to
   fetch it (confirm whether one exists or add a thin one).
3. **Install / authoring UX** — the low-friction path is a drop-in: create
   `~/.hoy/skills/<name>/SKILL.md` (or project `.hoy/skills`). A "New skill"
   scaffold + reveal-in-folder covers v1; a registry/URL installer is a later
   increment (overlaps HOY-315's install-UX scope).
4. **Diagnostics surfacing** — `loadSkills` returns validation errors; show them
   so a malformed skill is debuggable instead of silently missing.

## Open questions for the feature ticket

- Is there an RPC command that returns the loaded skill list + diagnostics, or do
  we add one alongside `get_commands`? (`get_commands` gives name+description but
  not filePath/source/diagnostics.)
- Does enable/disable mean editing frontmatter in place, or a Hoy-side settings
  overlay? Pi reads `disable-model-invocation` from the file; a settings overlay
  would need Pi support or a rewrite-on-toggle.
- Management panel placement: a tab in Settings vs a tenant in the right-side
  dock (the reusable multi-panel sidebar from HOY-277/280).
