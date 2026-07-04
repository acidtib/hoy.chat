import type { ModelShare } from "@/lib/usage";
import { formatTokens } from "@/lib/utils";

export function ModelRanking({ rows }: { rows: ModelShare[] }) {
  if (rows.length === 0) {
    return <p className="text-xs text-muted-foreground">No model usage yet.</p>;
  }
  return (
    <div className="space-y-1.5">
      {rows.map((r) => (
        <div key={r.model}>
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="min-w-0 truncate text-foreground">{r.model}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {formatTokens(r.tokens)} - {Math.round(r.share * 100)}%
            </span>
          </div>
          <div className="mt-1 h-1.5 bg-accent/40">
            <div className="h-full bg-brand" style={{ width: `${Math.max(2, r.share * 100)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}
