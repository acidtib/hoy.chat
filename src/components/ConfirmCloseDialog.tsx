import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { useSessionStore } from "@/state/store";

const COPY = {
  close: { verb: "Close", button: "Stop and close" },
  archive: { verb: "Archive", button: "Stop and archive" },
  delete: { verb: "Delete", button: "Stop and delete" },
} as const;

// Global confirm for tearing down a streaming thread (close/archive/delete).
// Rendered once in App; driven by the store's pendingTeardown.
export function ConfirmCloseDialog() {
  const pending = useSessionStore((s) => s.pendingTeardown);
  const confirmTeardown = useSessionStore((s) => s.confirmTeardown);
  const cancelTeardown = useSessionStore((s) => s.cancelTeardown);

  const copy = pending ? COPY[pending.action] : null;

  return (
    <AlertDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) cancelTeardown();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Response still streaming</AlertDialogTitle>
          <AlertDialogDescription>
            A response is still streaming. {copy?.verb} this thread and stop
            the response?
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={cancelTeardown}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={confirmTeardown}
            className={cn(
              pending?.action === "delete" &&
                "bg-destructive text-destructive-foreground hover:bg-destructive/90",
            )}
          >
            {copy?.button}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
