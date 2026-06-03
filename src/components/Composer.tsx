import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function Composer() {
  return (
    <div className="border-t border-border p-3">
      {/* Sending is wired in M3; disabled while a turn streams. */}
      <div className="mx-auto flex max-w-3xl items-center gap-2">
        <Input placeholder="Type a message... (enabled in M3)" disabled />
        <Button size="icon" disabled>
          <Send className="size-4" />
        </Button>
      </div>
    </div>
  );
}
