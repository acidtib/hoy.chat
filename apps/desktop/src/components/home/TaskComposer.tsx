import { useState } from "react";
import { ArrowUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSessionStore } from "@/state/store";

// The prominent "start a new task" input on the home dashboard (HOY-262).
// Submitting creates a thread in `projectId` (addThread also opens it) and
// prefills the typed text as the thread draft; the thread composer sends it.
// Auto-send on open is a follow-up (see HOY-262 out-of-scope).
export function TaskComposer({ projectId }: { projectId: string | null }) {
  const [text, setText] = useState("");
  const addThread = useSessionStore((s) => s.addThread);
  const setDraft = useSessionStore((s) => s.setDraft);
  const disabled = !projectId;

  function start() {
    const trimmed = text.trim();
    if (!trimmed || !projectId) return;
    const id = addThread(projectId);
    setDraft(id, trimmed);
    setText("");
  }

  return (
    <div className="border border-border bg-card focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring/60">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            start();
          }
        }}
        disabled={disabled}
        rows={3}
        placeholder={disabled ? "Open a project to start a task..." : "Start a new task..."}
        className="w-full resize-none bg-transparent px-3.5 py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
      />
      <div className="flex justify-end px-2 pb-2">
        <Button
          size="icon"
          onClick={start}
          disabled={disabled || text.trim().length === 0}
          aria-label="Start task"
        >
          <ArrowUp className="size-4" />
        </Button>
      </div>
    </div>
  );
}
