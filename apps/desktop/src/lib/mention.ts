// @-mention detection for the composer context picker (HOY-220). Pure so the
// Composer's dropdown logic stays testable.

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
