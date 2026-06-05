import { useEffect, useMemo, useState } from "react";
import { GitBranch, Minus, Settings, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { cn } from "@/lib/utils";
import { useSessionStore } from "@/state/store";

// Zed-style title bar over the main body (the window runs with native
// decorations off). The bar is the drag region: data-tauri-drag-region only
// applies to the element carrying it, so the attribute sits on the bar and the
// non-interactive left wrapper while the buttons stay clickable. Double-click
// to maximize comes with the drag region.
export function TitleBar() {
  const projects = useSessionStore((s) => s.projects);
  const activeThreadId = useSessionStore((s) => s.activeThreadId);
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);

  // The focused thread's project; before any thread is focused, the first
  // project stands in (matches the sidebar's ordering).
  const projectName = useMemo(() => {
    if (activeThreadId) {
      for (const p of projects) {
        if (p.threads.some((t) => t.id === activeThreadId)) return p.name;
      }
    }
    return projects[0]?.name ?? "Hoy";
  }, [projects, activeThreadId]);

  return (
    <header
      data-tauri-drag-region
      className="flex h-9 shrink-0 select-none items-center justify-between border-b border-border bg-sidebar pl-3 pr-1 text-xs text-muted-foreground"
    >
      <div data-tauri-drag-region className="flex min-w-0 items-center gap-2">
        <span
          data-tauri-drag-region
          className="truncate font-medium text-foreground"
        >
          {projectName}
        </span>
        {/* Mocked branch chip: real git status (branch/dirty/stash) is a
            follow-up; see FOLLOWUPS.md. */}
        <span
          data-tauri-drag-region
          className="flex items-center gap-1 rounded px-1 py-0.5"
        >
          <GitBranch className="size-3.5" data-tauri-drag-region />
          main
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        <TitleBarButton
          label="Settings"
          onClick={() => setSettingsOpen(true)}
          className="mr-1"
        >
          <Settings className="size-4" />
        </TitleBarButton>
        <WindowControls />
      </div>
    </header>
  );
}

function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    let cancelled = false;
    const sync = () => {
      void win.isMaximized().then((m) => {
        if (!cancelled) setMaximized(m);
      });
    };
    sync();
    const unlisten = win.onResized(sync);
    return () => {
      cancelled = true;
      void unlisten.then((fn) => fn());
    };
  }, []);

  return (
    <>
      <TitleBarButton
        label="Minimize"
        onClick={() => void getCurrentWindow().minimize()}
      >
        <Minus className="size-4" />
      </TitleBarButton>
      <TitleBarButton
        label={maximized ? "Restore" : "Maximize"}
        onClick={() => void getCurrentWindow().toggleMaximize()}
      >
        {maximized ? <RestoreIcon /> : <Square className="size-3.5" />}
      </TitleBarButton>
      <TitleBarButton
        label="Close"
        onClick={() => void getCurrentWindow().close()}
        className="hover:bg-destructive/80 hover:text-destructive-foreground"
      >
        <X className="size-4" />
      </TitleBarButton>
    </>
  );
}

// Two offset squares, the conventional restore-down glyph (lucide has no
// equivalent).
function RestoreIcon() {
  return (
    <svg
      viewBox="0 0 14 14"
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      aria-hidden
    >
      <rect x="2" y="4.5" width="7.5" height="7.5" rx="1" />
      <path d="M4.5 4.5V3a1 1 0 0 1 1-1H11a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1H9.5" />
    </svg>
  );
}

function TitleBarButton({
  label,
  onClick,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        "flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
        className,
      )}
    >
      {children}
    </button>
  );
}
