import { ScrollArea } from "@/components/ui/scroll-area";

const threads = [
  "Refactor sidebar collapse state",
  "Fix Tauri AppImage bundling",
  "Add updater pubkey config",
  "Rename bundle identifier",
  "Sync GitHub Actions versions",
  "Investigate JSONL framing bug",
  "Write auth.json read-modify-write",
  "Wire up tauri:dev MCP bridge",
];

export const Default = () => (
  <ScrollArea className="h-48 w-64 rounded-md border border-border">
    <div className="flex flex-col gap-1 p-2 text-sm">
      {threads.map((t) => (
        <div key={t} className="truncate rounded px-2 py-1.5 hover:bg-muted">
          {t}
        </div>
      ))}
    </div>
  </ScrollArea>
);
