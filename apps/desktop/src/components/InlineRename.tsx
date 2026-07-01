import { useState } from "react";
import { cn } from "@/lib/utils";

// Inline title editor shared by the sidebar thread rows and the panel header.
// Enter or blur commits, Escape cancels; unmounting the focused input fires no
// blur, so cancel never commits. The parent owns the editing flag and closes
// via onClose.
export function InlineRename({
  initial,
  onCommit,
  onClose,
  className,
}: {
  initial: string;
  onCommit: (value: string) => void;
  onClose: () => void;
  className?: string;
}) {
  const [draft, setDraft] = useState(initial);

  function commit() {
    onCommit(draft);
    onClose();
  }

  return (
    <input
      value={draft}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") onClose();
      }}
      className={cn(
        "rounded border border-border bg-background/60 px-1 text-foreground focus:outline-none",
        className,
      )}
    />
  );
}
