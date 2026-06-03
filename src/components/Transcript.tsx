import { AlertCircle, ArrowUpRight } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { PiState } from "@/lib/types";

// Visual-only prompt suggestions. Wiring lands with the composer in M3.
const EXAMPLE_PROMPTS = [
  "Explain this codebase to me",
  "Add a test for the parser",
  "Find and fix the failing build",
];

function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
      <div className="flex size-14 items-center justify-center rounded-2xl bg-brand/10 ring-1 ring-inset ring-brand/20">
        <span className="text-3xl leading-none text-brand">&#960;</span>
      </div>
      <h1 className="mt-5 text-xl font-semibold tracking-tight text-foreground">
        Start a conversation
      </h1>
      <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
        Ask Pi to read, write, and reason about your code. Pick a model above,
        then send a message to begin.
      </p>
      <div className="mt-7 flex w-full max-w-md flex-col gap-2">
        {EXAMPLE_PROMPTS.map((prompt) => (
          <div
            key={prompt}
            className="group flex cursor-default items-center justify-between rounded-xl border border-border bg-card/50 px-4 py-3 text-sm text-foreground/90 transition-colors"
          >
            <span>{prompt}</span>
            <ArrowUpRight className="size-4 shrink-0 text-muted-foreground/60" />
          </div>
        ))}
      </div>
    </div>
  );
}

// `debug` is the get_state payload shown on demand from the top-bar Debug action,
// never the default view. Real messages render here in M3.
export function Transcript({
  debug,
  error,
}: {
  debug: PiState | null;
  error: string | null;
}) {
  return (
    <ScrollArea className="scrollbar-thin flex-1">
      <div className="mx-auto flex min-h-[calc(100vh-7rem)] w-full max-w-3xl flex-col gap-4 px-6 py-6">
        {error && (
          <div className="flex items-start gap-2.5 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span className="leading-relaxed">{error}</span>
          </div>
        )}

        {debug ? (
          <div className="rounded-xl border border-border bg-card/60">
            <div className="flex items-center justify-between gap-2 px-4 py-3 text-xs font-medium text-muted-foreground">
              <span className="flex items-center gap-2 uppercase tracking-wider">
                <span className="size-1.5 rounded-full bg-brand" aria-hidden />
                get_state round-trip
              </span>
              <span className="text-[11px] tabular-nums text-muted-foreground/70">
                session {debug.sessionId.slice(0, 8)}
              </span>
            </div>
            <pre className="scrollbar-thin overflow-x-auto border-t border-border px-4 py-3 font-mono text-xs leading-relaxed text-card-foreground/90">
              {JSON.stringify(debug, null, 2)}
            </pre>
          </div>
        ) : (
          <EmptyState />
        )}
      </div>
    </ScrollArea>
  );
}
