import { ScrollArea } from "@/components/ui/scroll-area";
import type { PiState } from "@/lib/types";

export function Transcript({
  state,
  error,
}: {
  state: PiState | null;
  error: string | null;
}) {
  return (
    <ScrollArea className="flex-1">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
        {!state && !error && (
          <p className="text-sm text-muted-foreground">
            No messages yet. Streaming chat arrives in M3.
          </p>
        )}
        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}
        {state && (
          <div className="rounded-md border border-border bg-card p-3">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              get_state (debug round-trip)
            </p>
            <pre className="overflow-x-auto text-xs leading-relaxed text-card-foreground">
              {JSON.stringify(state, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
