// The thread model glyph's color is a "live fleet" signal (HOY-302): a thread's
// icon reads teal (text-agent) only while it has one or more subagents actually
// running, and neutral/muted otherwise -- regardless of whether the thread is
// active or open.
//
// This narrows HOY-256's static per-thread identity coloring for this glyph:
// color now means "this thread has a live fleet" at a glance rather than static
// identity. Active-row emphasis is carried by the row background/text, not the
// icon color.
export function threadIconColorClass(opts: { hasRunningSubagents: boolean }): string {
  return opts.hasRunningSubagents ? "text-agent" : "text-muted-foreground";
}
