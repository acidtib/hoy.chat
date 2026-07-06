import { useEffect, useState } from "react";
import { BarChart3, Bot, GitBranch, Minus, Settings, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { findThread, useSessionStore } from "@/state/store";

// Mirror of @tauri-apps/api window.d.ts ResizeDirection, which is not exported.
type ResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

// Zed-style title bar over the main body (the window runs with native
// decorations off). The bar is the drag region: data-tauri-drag-region only
// applies to the element carrying it, so the attribute sits on the bar and the
// non-interactive left wrapper while the buttons stay clickable. Double-click
// to maximize comes with the drag region.
export function TitleBar() {
  const projects = useSessionStore((s) => s.projects);
  const activeThreadId = useSessionStore((s) => s.activeThreadId);
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);
  const bodyView = useSessionStore((s) => s.bodyView);
  const setBodyView = useSessionStore((s) => s.setBodyView);

  // The focused thread's project; with no thread focused (home page) the left
  // side stays empty.
  const projectName = activeThreadId
    ? (findThread(projects, activeThreadId)?.project.name ?? null)
    : null;

  return (
    <header
      data-tauri-drag-region
      className="flex h-9 shrink-0 select-none items-center justify-between border-b border-border bg-sidebar pl-3 pr-1 text-xs text-muted-foreground"
    >
      <div data-tauri-drag-region className="flex min-w-0 items-center gap-2">
        {projectName && (
          <>
            <span
              data-tauri-drag-region
              className="truncate font-medium text-foreground"
            >
              {projectName}
            </span>
            {/* Mocked branch chip to match the website app mock; real git
                status (branch/dirty/stash) is not wired yet. Tracked in
                HOY-306. */}
            <span
              data-tauri-drag-region
              className="flex shrink-0 items-center gap-1"
              title="Branch switching is not available yet"
            >
              <GitBranch className="size-3.5" />
              main
            </span>
          </>
        )}
      </div>

      {/* Global view/app controls, left → right: Usage toggle, FleetView
          toggle, Settings cog, then the window controls. The two body-view
          toggles keep their footer active treatment (brand for Usage,
          text-agent for the agents/fleet view). */}
      <div className="flex shrink-0 items-center gap-0.5">
        <TitleBarButton
          label={bodyView === "usage" ? "Show Panels" : "Show Usage Stats"}
          onClick={() => setBodyView(bodyView === "usage" ? "panels" : "usage")}
          active={bodyView === "usage"}
        >
          <BarChart3 className="size-4" />
        </TitleBarButton>
        <TitleBarButton
          label={bodyView === "fleet" ? "Show Panels" : "Show FleetView"}
          onClick={() => setBodyView(bodyView === "fleet" ? "panels" : "fleet")}
          active={bodyView === "fleet"}
          activeClassName="text-agent"
        >
          <Bot className="size-4" />
        </TitleBarButton>
        <TitleBarButton
          label="Settings"
          onClick={() => setSettingsOpen(true)}
        >
          <Settings className="size-4" />
        </TitleBarButton>
        <div aria-hidden className="w-3" />
        <WindowControls />
      </div>
    </header>
  );
}

function useMaximized(): boolean {
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

  return maximized;
}

// With decorations off the window manager provides no resize borders, so thin
// invisible strips along the window edges hand the gesture to the WM via
// startResizeDragging. Hidden while maximized (nothing to resize, and the top
// strip would shadow the title bar's first pixels).
const RESIZE_HANDLES: { dir: ResizeDirection; className: string }[] = [
  { dir: "North", className: "inset-x-2 top-0 h-1 cursor-n-resize" },
  { dir: "South", className: "inset-x-2 bottom-0 h-1 cursor-s-resize" },
  { dir: "West", className: "inset-y-2 left-0 w-1 cursor-w-resize" },
  { dir: "East", className: "inset-y-2 right-0 w-1 cursor-e-resize" },
  { dir: "NorthWest", className: "left-0 top-0 size-2 cursor-nw-resize" },
  { dir: "NorthEast", className: "right-0 top-0 size-2 cursor-ne-resize" },
  { dir: "SouthWest", className: "bottom-0 left-0 size-2 cursor-sw-resize" },
  { dir: "SouthEast", className: "bottom-0 right-0 size-2 cursor-se-resize" },
];

export function WindowResizeHandles() {
  const maximized = useMaximized();
  if (maximized) return null;

  return (
    <>
      {RESIZE_HANDLES.map(({ dir, className }) => (
        <div
          key={dir}
          onPointerDown={(e) => {
            e.preventDefault();
            void getCurrentWindow().startResizeDragging(dir);
          }}
          className={cn("fixed z-50", className)}
        />
      ))}
    </>
  );
}

function WindowControls() {
  const maximized = useMaximized();

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
  active = false,
  activeClassName = "text-brand",
}: {
  label: string;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
  active?: boolean;
  // Color when active; defaults to the brand navigation color, overridden by
  // callers representing a different surface (e.g. text-agent for FleetView).
  activeClassName?: string;
}) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        "size-7 hover:text-foreground",
        active ? activeClassName : "text-muted-foreground",
        className,
      )}
    >
      {children}
    </Button>
  );
}
