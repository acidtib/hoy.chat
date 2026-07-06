// Skill-invocation parsing for the transcript (HOY-323). When a user runs
// `/skill:<name>`, Pi's agent-session rewrites that turn's text into a
// `<skill name=... location=...>...</skill>` block (optionally followed by the
// user's own args), and that block is what arrives back over RPC as the user
// message text. This mirrors Pi's parseSkillBlock (core/agent-session.ts) so the
// renderer can show a `[skill] name` chip instead of raw XML. It's a pure
// function, so it stays testable and cheap to call per user turn.

export interface ParsedSkillBlock {
  // Skill name from the block's name attribute (e.g. "commit-helper").
  name: string;
  // Absolute path to the SKILL.md the block was expanded from.
  location: string;
  // The skill body (markdown), between the tags.
  content: string;
  // The user's own text appended after the block, if any.
  userMessage: string | undefined;
}

// Matches the exact shape Pi emits: the opening tag on its own line, the body,
// the closing tag, then an optional blank-line-separated user message. Anchored
// to the start so a stray `<skill>` mid-message never triggers the chip.
const SKILL_BLOCK_RE =
  /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/;

export function parseSkillBlock(text: string): ParsedSkillBlock | null {
  const match = text.match(SKILL_BLOCK_RE);
  if (!match) return null;
  return {
    name: match[1],
    location: match[2],
    content: match[3],
    userMessage: match[4]?.trim() || undefined,
  };
}

// Strip the `skill:` prefix from a skill command's name. Skills arrive from
// get_commands / list_skills as `skill:<name>`; this is the bare `<name>` the
// user sees in the picker and types. Shared so the display, the `@skill:`
// filter, and the submit rewrite agree on one convention (HOY-323).
export function bareSkillName(name: string): string {
  return name.replace(/^skill:/, "");
}

// The minimal shape rewriteSkillCommand needs from a Pi slash command
// (get_commands): its name and where it came from. Skills arrive as
// `skill:<name>`; every other source keeps its bare name.
interface NamedCommand {
  name: string;
  source: string;
}

// In the composer a skill is invoked by its bare name (`/demo-review`), matching
// Claude Code, but Pi only expands the `/skill:<name>` form (HOY-323). Rewrite a
// leading `/<name>` to `/skill:<name>` when `<name>` is a known skill that isn't
// shadowed by a non-skill command of the same name (an extension/prompt command
// wins, so its literal `/<name>` reaches Pi unchanged). Anything that isn't a
// bare `/<name>` (plain prose, an already-prefixed `/skill:x`, or a name with no
// matching skill) is returned untouched. Only the leading command token is
// considered; trailing args are preserved verbatim.
export function rewriteSkillCommand(
  text: string,
  commands: NamedCommand[],
): string {
  const match = /^\/([a-zA-Z0-9-]+)(\s[\s\S]*)?$/.exec(text);
  if (!match) return text;
  const token = match[1];
  let isSkill = false;
  let shadowed = false;
  for (const command of commands) {
    if (command.source === "skill") {
      if (bareSkillName(command.name) === token) isSkill = true;
    } else if (command.name === token) {
      shadowed = true;
    }
  }
  if (!isSkill || shadowed) return text;
  return `/skill:${token}${match[2] ?? ""}`;
}
