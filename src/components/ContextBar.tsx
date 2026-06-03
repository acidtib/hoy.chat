import { cn } from "@/lib/utils";
import type { PiState } from "@/lib/types";

// Thin bottom strip (Hermes-desktop style). Real context-window usage and cost
// arrive in M3 via get_session_stats; for now shows placeholders plus live model
// and status once a get_state round-trip has run.
export function ContextBar({ state }: { state: PiState | null }) {
  const model = state?.model?.id ?? "no model";
  const streaming = state?.isStreaming ?? false;
  const status = streaming ? "streaming" : "idle";

  return (
    <footer className="flex h-8 shrink-0 items-center gap-3 border-t border-border bg-sidebar px-4 text-[11px] text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span
          className={cn(
            "size-1.5 rounded-full",
            streaming ? "animate-pulse bg-brand" : "bg-muted-foreground/50",
          )}
          aria-hidden
        />
        <span className="capitalize">{status}</span>
      </span>

      <Divider />

      <span className="font-mono tabular-nums">ctx --/-- &middot; --%</span>

      <Divider />

      <span className="font-mono tabular-nums">$--</span>

      <span className="ml-auto truncate font-mono text-muted-foreground/80">
        {model}
      </span>
    </footer>
  );
}

function Divider() {
  return <span className="h-3 w-px bg-border" aria-hidden />;
}
