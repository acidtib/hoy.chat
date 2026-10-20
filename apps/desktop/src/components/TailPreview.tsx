import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

// Enough source to fill the visible lines without laying out a long stream.
const TAIL_LINES = 8;
const TAIL_CHARS = 1200;

export function tailOf(text: string): string {
  const lines = text.trimEnd().split("\n");
  const tail = lines.slice(-TAIL_LINES).join("\n");
  return tail.length > TAIL_CHARS ? tail.slice(-TAIL_CHARS) : tail;
}

// The last three visual lines of a streaming part, bottom-anchored and faded at
// the top. Clicking it expands the part.
export function TailPreview({
  text,
  onExpand,
  label,
  mono = false,
  diff = false,
  className,
}: {
  text: string;
  onExpand: () => void;
  label: string;
  mono?: boolean;
  diff?: boolean;
  className?: string;
}) {
  const tail = tailOf(text);
  const ref = useRef<HTMLButtonElement>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    const inner = el?.firstElementChild as HTMLElement | null;
    if (el && inner) setClipped(inner.offsetHeight > el.clientHeight + 1);
  }, [tail]);
  if (!tail) return null;
  return (
    <button
      ref={ref}
      type="button"
      onClick={onExpand}
      aria-label={label}
      className={cn(
        "flex max-h-[3.75rem] w-full cursor-pointer flex-col justify-end overflow-hidden text-left leading-5 text-muted-foreground hover:text-foreground/80",
        clipped && "[mask-image:linear-gradient(to_bottom,transparent,black_1.25rem)]",
        mono ? "font-mono text-xs" : "text-sm",
        className,
      )}
    >
      <span className="block whitespace-pre-wrap break-words">
        {diff
          ? tail.split("\n").map((line, i) => (
              <span
                key={i}
                className={cn(
                  "block",
                  line.startsWith("+") && "text-emerald-500/80",
                  line.startsWith("-") && "text-red-500/80",
                )}
              >
                {line || " "}
              </span>
            ))
          : tail}
      </span>
    </button>
  );
}
