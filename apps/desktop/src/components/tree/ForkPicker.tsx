import { GitBranch } from "lucide-react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useSessionStore } from "@/state/store";

// HOY-284: the /fork command's picker. Lists the active thread's forkable user
// messages (get_fork_messages); choosing one branches a new thread from that
// point (store.pickFork -> branchFromEntry). A command-palette list, matching
// pi's /fork UX. Rendered once at the app root; open state lives in the store.
export function ForkPicker() {
  const picker = useSessionStore((s) => s.forkPicker);
  const pickFork = useSessionStore((s) => s.pickFork);
  const closeForkPicker = useSessionStore((s) => s.closeForkPicker);

  return (
    <CommandDialog
      open={picker !== null}
      onOpenChange={(open) => {
        if (!open) closeForkPicker();
      }}
      title="Fork from a message"
      description="Pick a user message to branch a new thread from."
    >
      {/* CommandDialog provides only the dialog shell; cmdk's Command context
          (needed by Input/List/Item) must be supplied here, as ModelSelector does. */}
      <Command>
        <CommandInput placeholder="Fork from which message?" />
        <CommandList>
          <CommandEmpty>No forkable messages.</CommandEmpty>
          {picker?.messages.map((m) => (
            <CommandItem
              key={m.entryId}
              // entryId keeps the value unique when two messages share text; the
              // text makes the row searchable.
              value={`${m.text} ${m.entryId}`}
              onSelect={() => pickFork(m.entryId)}
            >
              <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">
                {firstLine(m.text) || "(empty message)"}
              </span>
            </CommandItem>
          ))}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}

function firstLine(text: string): string {
  const t = text.trim();
  const nl = t.indexOf("\n");
  return nl === -1 ? t : t.slice(0, nl);
}
