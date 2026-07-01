// "/" slash-command detection for the composer autocomplete (HOY-223). Pure so
// the Composer's popup logic stays testable. Pi only dispatches a slash command
// when it is the very start of the message, so unlike @-mentions this triggers
// only on a leading "/" and never mid-text.

export interface Slash {
  // Text typed after the leading "/", up to the cursor (the picker's filter).
  query: string;
}

// Detect an active leading-slash command ending at `cursor`. The value must begin
// with "/" (index 0, no leading whitespace) and the caret must sit within that
// first token (no whitespace between the "/" and the cursor). Returns null
// otherwise, so a "/" that is not at message start never opens the picker.
export function detectSlash(value: string, cursor: number): Slash | null {
  if (value[0] !== "/" || cursor < 1) return null;
  const query = value.slice(1, cursor);
  if (/\s/.test(query)) return null;
  return { query };
}
