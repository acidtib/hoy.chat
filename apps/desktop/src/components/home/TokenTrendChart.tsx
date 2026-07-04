import { useState } from "react";
import type { UsageDay } from "@/lib/types";
import type { ModelBreakdown } from "@/lib/usage";
import { formatTokens } from "@/lib/utils";

// Daily token trend as a per-model stacked bar chart (HOY-264), modeled on
// ZCode's Daily Token Trend: dashed gridlines, a date axis, an on-chart hover
// tooltip with the day's per-model split, and a color legend below. Hand-rolled
// with flex bars to keep the square dark aesthetic and avoid a chart dependency.
const GRIDLINES = [0, 0.25, 0.5, 0.75, 1];

export function TokenTrendChart({
  days,
  breakdown,
}: {
  days: UsageDay[];
  breakdown: ModelBreakdown;
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (days.length === 0) {
    return (
      <div className="border border-border px-4 py-10 text-center text-xs text-muted-foreground">
        No activity in this range.
      </div>
    );
  }
  const max = Math.max(1, ...days.map((d) => d.tokens.total));
  const active = hover != null ? days[hover] : null;
  const labelIdx = axisLabelIndices(days.length);

  return (
    <div className="border border-border p-3">
      <div className="relative">
        {/* Dashed gridlines behind the bars. */}
        <div className="pointer-events-none absolute inset-0">
          {GRIDLINES.map((g) => (
            <div
              key={g}
              className="absolute inset-x-0 border-t border-dashed border-border/50"
              style={{ top: `${g * 100}%` }}
            />
          ))}
        </div>

        {/* Bars. */}
        <div className="flex h-44 items-end gap-px">
          {days.map((d, i) => {
            const segs = breakdown.daySegments(d);
            return (
              <button
                key={d.date}
                type="button"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover((h) => (h === i ? null : h))}
                className="group relative flex h-full flex-1 flex-col justify-end"
                aria-label={`${d.date}: ${formatTokens(d.tokens.total)} tokens`}
              >
                {segs
                  .filter((s) => s.tokens > 0)
                  .map((s) => (
                    <div
                      key={s.model}
                      className="w-full group-hover:opacity-90"
                      style={{
                        height: `${(s.tokens / max) * 100}%`,
                        backgroundColor: s.color,
                      }}
                    />
                  ))}
              </button>
            );
          })}
        </div>

        {/* On-chart hover tooltip. */}
        {active && hover != null && (
          <div
            className="pointer-events-none absolute top-0 z-10 w-56 -translate-x-1/2 border border-border bg-popover p-2 text-xs shadow-md"
            style={{
              left: `${clamp((hover + 0.5) / days.length, 0.18, 0.82) * 100}%`,
            }}
          >
            <div className="mb-1.5 border-b border-border pb-1.5">
              <div className="font-medium text-foreground">{active.date}</div>
              <div className="tabular-nums text-muted-foreground">
                Total {formatTokens(active.tokens.total)} tokens
              </div>
            </div>
            <div className="space-y-0.5">
              {breakdown
                .daySegments(active)
                .filter((s) => s.tokens > 0)
                .sort((a, b) => b.tokens - a.tokens)
                .map((s) => (
                  <div key={s.model} className="flex items-center gap-1.5">
                    <span
                      className="size-2 shrink-0"
                      style={{ backgroundColor: s.color }}
                    />
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {s.model}
                    </span>
                    <span className="tabular-nums text-foreground">
                      {formatTokens(s.tokens)}
                    </span>
                  </div>
                ))}
            </div>
          </div>
        )}
      </div>

      {/* Date axis. */}
      <div className="mt-1.5 flex text-[10px] text-muted-foreground">
        {days.map((d, i) => (
          <span key={d.date} className="flex-1 text-center">
            {labelIdx.has(i) ? shortDate(d.date) : ""}
          </span>
        ))}
      </div>

      {/* Model legend. */}
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 border-t border-border pt-3">
        {breakdown.ranked.map((m) => (
          <div key={m.model} className="flex items-center gap-1.5 text-[11px]">
            <span
              className="size-2.5 shrink-0"
              style={{ backgroundColor: m.color }}
            />
            <span className="text-muted-foreground">{m.model}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

// Roughly 6 evenly spaced axis labels (always the first and last).
function axisLabelIndices(n: number): Set<number> {
  if (n <= 1) return new Set([0]);
  const count = Math.min(6, n);
  const idx = new Set<number>();
  for (let i = 0; i < count; i++) {
    idx.add(Math.round((i / (count - 1)) * (n - 1)));
  }
  return idx;
}

function shortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
