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
    <div className="flex gap-[2px] overflow-x-auto pb-1">
      {grid.map((col, ci) => (
        <div key={ci} className="flex flex-col gap-[2px]">
          {col.map((cell) => {
            const ratio = cell.tokens > 0 ? 0.2 + 0.8 * (cell.tokens / max) : 0;
            return (
              <div
                key={cell.date}
                title={`${cell.date}: ${formatTokens(cell.tokens)} tokens`}
                className="size-2.5 shrink-0 border border-border/40 bg-brand"
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
  );
}
