// Deterministic per-thread identity colors.
//
// Every thread row used to fall through to a uniform grey icon, so a project's
// threads were visually indistinguishable (HOY-256). Instead we hash the thread
// id into a small curated palette (see the --thread-* tokens in index.css) so
// each thread keeps a stable, distinct hue everywhere it appears — the sidebar,
// thread history, and the thread header.
//
// The palette is reserved for IDLE threads. The active/open thread keeps the
// brand purple and agent (fleet) threads keep teal, so those learned semantics
// stay legible; only the previously-uniform idle rows gain identity.

// Full literal class names so Tailwind's scanner emits them — never build these
// with string interpolation (e.g. `text-thread-${i}`), which the scanner can't
// see.
const THREAD_COLOR_CLASSES = [
  "text-thread-1",
  "text-thread-2",
  "text-thread-3",
  "text-thread-4",
  "text-thread-5",
  "text-thread-6",
] as const;

/**
 * Map a thread id to a stable palette index via FNV-1a. Deterministic across
 * runs and machines, well-distributed for the short opaque ids we use, and
 * total: an empty or single-char id still yields a valid index.
 */
export function threadColorIndex(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % THREAD_COLOR_CLASSES.length;
}

/** Tailwind text-color class for a thread's stable identity hue. */
export function threadColorClass(id: string): string {
  return THREAD_COLOR_CLASSES[threadColorIndex(id)];
}

/**
 * The single source of truth for a thread icon's color across the app. Fleet
 * (agent) threads read teal, the active/open thread reads brand purple, and any
 * other (idle) thread gets its hashed identity hue instead of uniform grey.
 */
export function threadIconColorClass(opts: {
  id: string;
  active: boolean;
  isAgent: boolean;
}): string {
  if (opts.isAgent) return "text-agent";
  if (opts.active) return "text-brand";
  return threadColorClass(opts.id);
}
