// @-mention detection for the composer context picker (HOY-220). Pure so the
// Composer's dropdown logic stays testable.

import type { SlashCommand } from "@/lib/types";

export interface Mention {
  // Index of the triggering `@` in the value.
  at: number;
  // Text typed after the `@`, up to the cursor (the picker's filter query).
  query: string;
}

// Detect an active @-mention ending at `cursor`. A mention starts at an `@` on a
// word boundary (index 0 or preceded by whitespace) with no whitespace between it
// and the cursor. Returns null otherwise, so a literal `@` mid-word (an email,
// a handle) never opens the picker.
export function detectMention(value: string, cursor: number): Mention | null {
  for (let i = cursor - 1; i >= 0; i--) {
    const ch = value[i];
    if (ch === "@") {
      const prev = i > 0 ? value[i - 1] : "";
      if (i === 0 || /\s/.test(prev)) {
        return { at: i, query: value.slice(i + 1, cursor) };
      }
      return null;
    }
    if (/\s/.test(ch)) return null;
  }
  return null;
}

// The picker view parsed from the raw @token (text after the @, or null when
// button-opened). "@file:q" / "@thread:q" / "@command:q" scope to a category; a
// bare @ or button-open is the root menu; anything else is a fuzzy search over
// files + threads. `wantFiles` gates the (expensive) live path search — only the
// file and free search views need it (HOY-220, HOY-286).
export type PickerView = "root" | "file" | "thread" | "command" | "search";

export interface ParsedToken {
  view: PickerView;
  q: string;
  wantFiles: boolean;
}

export function parseToken(token: string | null): ParsedToken {
  if (token === null || token === "") {
    return { view: "root", q: "", wantFiles: false };
  }
  const typed = /^(file|thread|command):(.*)$/i.exec(token);
  if (typed) {
    const kind = typed[1].toLowerCase();
    const view: PickerView =
      kind === "thread" ? "thread" : kind === "command" ? "command" : "file";
    return { view, q: typed[2], wantFiles: view === "file" };
  }
  return { view: "search", q: token, wantFiles: true };
}

// The command list shared by the "/" autocomplete and the "@" Commands category
// (HOY-223, HOY-286): built-ins plus the session's commands, deduped by name (a
// built-in wins), filtered by a case-insensitive substring of the command name.
// Skills carry a "skill:" name prefix; the query matches the full name so
// "/skill:x" still filters.
export function filterCommands(
  builtins: SlashCommand[],
  session: SlashCommand[],
  query: string,
): SlashCommand[] {
  const builtinNames = new Set(builtins.map((c) => c.name));
  const q = query.toLowerCase();
  return [
    ...builtins,
    ...session.filter((c) => !builtinNames.has(c.name)),
  ].filter((c) => c.name.toLowerCase().includes(q));
}
