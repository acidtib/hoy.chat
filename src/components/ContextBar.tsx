import type { PiState } from "@/lib/types";

// Thin bottom strip (Hermes-desktop style). Real context-window usage and cost
// arrive in M3 via get_session_stats; M1 shows placeholders plus live model and
// status once a get_state round-trip has run.
export function ContextBar({ state }: { state: PiState | null }) {
  const model = state?.model?.id ?? "no model";
  const status = state?.isStreaming ? "streaming" : "idle";
  return (
    <footer className="flex h-7 shrink-0 items-center gap-3 border-t border-border px-3 text-xs text-muted-foreground">
      <span>ctx — / — · —%</span>
      <span aria-hidden>·</span>
      <span>$—</span>
      <span aria-hidden>·</span>
      <span>{model}</span>
      <span aria-hidden>·</span>
      <span>{status}</span>
    </footer>
  );
}
