import { ArrowUp, Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";

export function Composer() {
  // Sending is wired in M3; rendered as a polished disabled prompt input.
  return (
    <div className="shrink-0 border-t border-border bg-background/60 px-4 pb-4 pt-3 backdrop-blur-sm">
      <div className="mx-auto w-full max-w-3xl">
        <div className="rounded-2xl border border-border bg-card/60 opacity-70 shadow-sm transition-colors focus-within:border-ring/60">
          <textarea
            rows={1}
            disabled
            placeholder="Message Pi..."
            className="block w-full resize-none bg-transparent px-4 pt-3.5 text-sm leading-relaxed text-foreground placeholder:text-muted-foreground focus:outline-none disabled:cursor-not-allowed"
          />
          <div className="flex items-center justify-between px-2.5 pb-2.5 pt-1">
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              disabled
              aria-label="Attach"
            >
              <Paperclip className="size-4" />
            </Button>
            <Button
              size="icon-sm"
              className="rounded-lg"
              disabled
              aria-label="Send message"
            >
              <ArrowUp className="size-4" />
            </Button>
          </div>
        </div>
        <p className="mt-2 px-1 text-center text-[11px] text-muted-foreground/70">
          Streaming chat is enabled in M3.
        </p>
      </div>
    </div>
  );
}
