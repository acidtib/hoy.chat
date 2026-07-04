import type { RankedModel } from "@/lib/usage";
import { formatTokens } from "@/lib/utils";

// Model usage as a donut (total tokens in the center) plus a share ranking
// (HOY-264), modeled on ZCode's Model Usage. Colors come from the shared model
// palette so the donut, legend, and trend stacks agree.
const SIZE = 148;
const STROKE = 20;

export function ModelUsage({
  ranked,
  total,
}: {
  ranked: RankedModel[];
  total: number;
}) {
  if (ranked.length === 0) {
    return <p className="text-xs text-muted-foreground">No model usage yet.</p>;
  }
  const r = (SIZE - STROKE) / 2;
  const c = 2 * Math.PI * r;
  let offset = 0;

  return (
    <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-center sm:gap-8">
      <div className="relative shrink-0" style={{ width: SIZE, height: SIZE }}>
        <svg width={SIZE} height={SIZE} className="-rotate-90">
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={r}
            fill="none"
            className="text-accent/40"
            stroke="currentColor"
            strokeWidth={STROKE}
          />
          {ranked.map((m) => {
            const len = m.share * c;
            const seg = (
              <circle
                key={m.model}
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={r}
                fill="none"
                stroke={m.color}
                strokeWidth={STROKE}
                strokeDasharray={`${len} ${c - len}`}
                strokeDashoffset={-offset}
              />
            );
            offset += len;
            return seg;
          })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-xl font-semibold tabular-nums tracking-tight text-foreground">
            {formatTokens(total)}
          </span>
          <span className="text-xs text-muted-foreground">tokens</span>
        </div>
      </div>

      <div className="min-w-0 flex-1 divide-y divide-border self-stretch">
        {ranked.map((m) => (
          <div key={m.model} className="flex items-center gap-3 py-2.5">
            <span
              className="size-2.5 shrink-0"
              style={{ backgroundColor: m.color }}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-foreground">{m.model}</p>
              <p className="text-xs text-muted-foreground">
                {formatTokens(m.tokens)} tokens
              </p>
            </div>
            <span className="shrink-0 text-sm tabular-nums text-foreground">
              {Math.round(m.share * 100)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
