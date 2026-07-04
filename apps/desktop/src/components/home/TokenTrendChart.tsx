import { useState } from "react";
import type { UsageDay } from "@/lib/types";
import { formatTokens } from "@/lib/utils";

// Daily token bars with a details panel showing the hovered day's per-model
// split (HOY-262). Hand-rolled flex bars to keep the square dark aesthetic and
// avoid a charting dependency.
export function TokenTrendChart({ days }: { days: UsageDay[] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (days.length === 0) {
    return (
      <div className="border border-border px-4 py-8 text-center text-xs text-muted-foreground">
        No activity in this range.
      </div>
    );
  }
  const max = Math.max(1, ...days.map((d) => d.tokens.total));
  const active = hover != null ? days[hover] : null;
  return (
    <div>
      <div className="flex h-32 items-end gap-px">
        {days.map((d, i) => (
          <button
            key={d.date}
            type="button"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover((h) => (h === i ? null : h))}
            className="group relative h-full min-w-0 flex-1"
            aria-label={`${d.date}: ${formatTokens(d.tokens.total)} tokens`}
          >
            <div
              className="absolute bottom-0 w-full bg-brand/60 transition-colors group-hover:bg-brand"
              style={{ height: `${Math.max(1, (d.tokens.total / max) * 100)}%` }}
            />
          </button>
        ))}
      </div>
      <div className="mt-2 min-h-[2.5rem] border border-border px-2 py-1.5 text-xs">
        {active ? (
          <>
            <div className="flex justify-between">
              <span className="font-medium text-foreground">{active.date}</span>
              <span className="tabular-nums text-muted-foreground">
                {formatTokens(active.tokens.total)} tokens
              </span>
            </div>
            <div className="mt-1 space-y-0.5">
              {Object.entries(active.byModel)
                .sort((a, b) => b[1] - a[1])
                .map(([m, t]) => (
                  <div key={m} className="flex justify-between gap-3">
                    <span className="min-w-0 truncate text-muted-foreground">{m}</span>
                    <span className="tabular-nums text-foreground">{formatTokens(t)}</span>
                  </div>
                ))}
            </div>
          </>
        ) : (
          <span className="text-muted-foreground">Hover a bar for the daily breakdown.</span>
        )}
      </div>
    </div>
  );
}
