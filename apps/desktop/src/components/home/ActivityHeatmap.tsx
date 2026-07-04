import type { UsageDay } from "@/lib/types";
import { heatmapGrid } from "@/lib/usage";
import { formatTokens } from "@/lib/utils";

// 53-week activity grid (HOY-262). Intensity scales opacity of the brand color;
// the row scrolls horizontally if the column is too narrow to hold a full year.
const WEEKS = 53;

export function ActivityHeatmap({ days }: { days: UsageDay[] }) {
  const grid = heatmapGrid(days, WEEKS);
  const max = Math.max(1, ...days.map((d) => d.tokens.total));
  return (
    <div>
      <div className="flex w-full gap-[2px]">
        {grid.map((col, ci) => (
          <div key={ci} className="flex flex-1 flex-col gap-[2px]">
            {col.map((cell) => {
              const ratio = cell.tokens > 0 ? 0.2 + 0.8 * (cell.tokens / max) : 0;
              return (
                <div
                  key={cell.date}
                  title={`${cell.date}: ${formatTokens(cell.tokens)} tokens`}
                  className="aspect-square w-full border border-border/40 bg-brand"
                  style={{
                    opacity: ratio || undefined,
                    backgroundColor: cell.tokens > 0 ? undefined : "transparent",
                  }}
                />
              );
            })}
          </div>
        ))}
      </div>

      {/* Intensity legend. */}
      <div className="mt-2 flex items-center justify-end gap-1.5 text-[10px] text-muted-foreground">
        <span>Less</span>
        {[0, 0.2, 0.45, 0.7, 1].map((o, i) => (
          <span
            key={i}
            className="size-2.5 border border-border/40 bg-brand"
            style={{
              opacity: o || undefined,
              backgroundColor: o === 0 ? "transparent" : undefined,
            }}
          />
        ))}
        <span>More</span>
      </div>
    </div>
  );
}
