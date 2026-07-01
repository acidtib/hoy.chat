// The composer draft encodes @ mentions inline (HOY-220) so the rich editor
// round-trips: each mention is serialized between a pair of NUL delimiters, which
// the user can never type and JSON.stringify never emits, so splitting on NUL
// cleanly separates plain text from mention refs. The draft is the single source
// of truth (persisted as-is); the message Pi sees replaces each marker with the
// ref's label, and contexts are derived from the markers.

import { contextKey } from "./types";
import type { ContextRef } from "./types";

const DELIM = "\u0000";

export function mentionMarker(ref: ContextRef): string {
  return DELIM + JSON.stringify(ref) + DELIM;
}

export type DraftPart =
  | { type: "text"; text: string }
  | { type: "mention"; ref: ContextRef };

export function draftToParts(draft: string): DraftPart[] {
  const parts: DraftPart[] = [];
  const segments = draft.split(DELIM);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    // Odd segments sit between a delimiter pair: a serialized mention ref.
    if (i % 2 === 1) {
      try {
        const ref = JSON.parse(seg) as ContextRef;
        if (
          ref &&
          (ref.kind === "file" ||
            ref.kind === "directory" ||
            ref.kind === "thread")
        ) {
          parts.push({ type: "mention", ref });
          continue;
        }
      } catch {
        // Not a valid ref; fall through and treat the segment as text.
      }
    }
    if (seg) parts.push({ type: "text", text: seg });
  }
  return parts;
}

export function mentionLabel(ref: ContextRef): string {
  return ref.kind === "thread" ? ref.title : ref.name;
}

// The message Pi receives: markers replaced by their label so the sentence reads
// naturally (the actual content is inlined separately as a <context> block).
export function draftToMessage(draft: string): string {
  return draftToParts(draft)
    .map((p) => (p.type === "text" ? p.text : mentionLabel(p.ref)))
    .join("");
}

// Unique context refs mentioned in the draft, in order (deduped by key).
export function draftContexts(draft: string): ContextRef[] {
  const seen = new Set<string>();
  const out: ContextRef[] = [];
  for (const part of draftToParts(draft)) {
    if (part.type !== "mention") continue;
    const key = contextKey(part.ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(part.ref);
  }
  return out;
}

// True when the draft has no mention and only whitespace text (drives the
// composer placeholder and the empty-send guard).
export function draftIsEmpty(draft: string): boolean {
  return !draftToParts(draft).some(
    (p) => p.type === "mention" || (p.type === "text" && p.text.trim() !== ""),
  );
}
