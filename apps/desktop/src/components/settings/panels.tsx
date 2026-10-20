import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Archive,
  Boxes,
  Brain,
  Download,
  Mic,
  Monitor,
  Network,
  RefreshCw,
  ShieldCheck,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { arch, platform, version } from "@tauri-apps/plugin-os";
import { getVersion } from "@tauri-apps/api/app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { pickDirectory } from "@/lib/ipc";
import type { CategoryId } from "./categories";
import { ProvidersPanel } from "./ProvidersPanel";
import { ModelsPanel } from "./ModelsPanel";
import { ThemeSelector } from "./ThemeSelector";
import { McpPanel } from "./McpPanel";
import { IntegrationsPanel } from "./IntegrationsPanel";
import { SubagentsPanel } from "./SubagentsPanel";
import { SkillsPanel } from "./SkillsPanel";
import { useSessionStore } from "@/state/store";
import { usePrefsStore } from "@/state/prefs";

// Pinned Pi version (packages/sidecar. See docs/pi-version-bump.md). Surfaced in About.
const PI_VERSION = "1.3.0";

export function PanelHeader({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div>
      <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
      {description && (
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      )}
    </div>
  );
}

// Square theme (--radius: 0): a settings section is a hairline-bordered block,
// matching the Providers panel language rather than a rounded card.
export function Section({
  title,
  description,
  action,
  children,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="border border-border bg-card/40 p-5">
      {(title || action) && (
        <div className="flex items-start justify-between gap-3">
          <div>
            {title && <h2 className="text-sm font-semibold">{title}</h2>}
            {description && (
              <p className="mt-1 text-xs text-muted-foreground">
                {description}
              </p>
            )}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function StatusDot({ on = true }: { on?: boolean }) {
  return (
    <span
      className={
        "size-2 shrink-0 rounded-full " +
        (on
          ? "bg-emerald-500 shadow-[0_0_0_3px] shadow-emerald-500/15"
          : "bg-muted-foreground/40")
      }
      aria-hidden
    />
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

// Controlled toggle row. Every toggle in these panels is backed by real state
// (a preference or a Pi session setting). There are no cosmetic switches.
function ToggleRow({
  label,
  description,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {description && (
          <p className="text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}

// Honest placeholder for a category that has no backing yet (Pi exposes no RPC
// for it, or it is a deferred feature). No fake inputs: a plain empty state plus
// the concrete capabilities it will gain, so the surface stays truthful.
function Placeholder({
  title,
  description,
  icon: Icon,
  blurb,
  points,
}: {
  title: string;
  description?: string;
  icon: LucideIcon;
  blurb: string;
  points?: string[];
}) {
  return (
    <div className="space-y-6">
      <PanelHeader title={title} description={description} />
      <div className="border border-dashed border-border bg-card/20 px-6 py-12 text-center">
        <span
          className="mx-auto flex size-10 items-center justify-center border border-border bg-muted/50 text-muted-foreground"
          aria-hidden
        >
          <Icon className="size-5" />
        </span>
        <p className="mt-4 text-sm font-medium">Not available yet</p>
        <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
          {blurb}
        </p>
      </div>
      {points && points.length > 0 && (
        <div className="border border-border">
          <p className="bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
            Planned
          </p>
          <ul className="divide-y divide-border">
            {points.map((p) => (
              <li key={p} className="px-3 py-2.5 text-sm text-muted-foreground">
                {p}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ChatPanel() {
  const sendOnEnter = usePrefsStore((s) => s.sendOnEnter);
  const autoTitles = usePrefsStore((s) => s.autoTitles);
  const showReasoning = usePrefsStore((s) => s.showReasoning);
  const expandEditTools = usePrefsStore((s) => s.expandEditTools);
  const expandShellTools = usePrefsStore((s) => s.expandShellTools);
  const setPref = usePrefsStore((s) => s.setPref);

  return (
    <div className="space-y-8">
      <PanelHeader
        title="Chat"
        description="How the composer and transcript behave."
      />
      <Section>
        <ToggleRow
          label="Send on Enter"
          description="Enter sends; Shift+Enter inserts a newline. When off, Enter adds a newline and Cmd/Ctrl+Enter sends."
          checked={sendOnEnter}
          onChange={(v) => setPref("sendOnEnter", v)}
        />
        <Separator />
        <ToggleRow
          label="Name threads automatically"
          description="Title new threads from their first message using a small, fast model"
          checked={autoTitles}
          onChange={(v) => setPref("autoTitles", v)}
        />
        <Separator />
        <ToggleRow
          label="Show reasoning"
          description="Display model reasoning in the timeline"
          checked={showReasoning}
          onChange={(v) => setPref("showReasoning", v)}
        />
        <Separator />
        <ToggleRow
          label="Expand edit tool parts"
          description="Show edit, write, and patch tool parts expanded by default in the timeline"
          checked={expandEditTools}
          onChange={(v) => setPref("expandEditTools", v)}
        />
        <Separator />
        <ToggleRow
          label="Expand shell tool parts"
          description="Show shell tool parts expanded by default in the timeline"
          checked={expandShellTools}
          onChange={(v) => setPref("expandShellTools", v)}
        />
      </Section>
    </div>
  );
}

function WorkspacePanel() {
  const defaultProjectDir = usePrefsStore((s) => s.defaultProjectDir);
  const autoOpenSpawnedThreads = usePrefsStore((s) => s.autoOpenSpawnedThreads);
  const requireSubagentApproval = usePrefsStore((s) => s.requireSubagentApproval);
  const maxConcurrentAgents = usePrefsStore((s) => s.maxConcurrentAgents);
  const keepAwakeWhileStreaming = usePrefsStore((s) => s.keepAwakeWhileStreaming);
  const setPref = usePrefsStore((s) => s.setPref);

  async function browse() {
    const dir = await pickDirectory(defaultProjectDir || undefined);
    if (dir) setPref("defaultProjectDir", dir);
  }

  return (
    <div className="space-y-8">
      <PanelHeader
        title="Workspace"
        description="Defaults for opening projects and how agent work runs."
      />
      <Section>
        <Field
          label="Default project directory"
          hint="Where the Open project picker starts. Leave empty to use the system default."
        >
          <div className="flex items-center gap-2">
            <Input
              value={defaultProjectDir}
              placeholder="System default"
              spellCheck={false}
              onChange={(e) => setPref("defaultProjectDir", e.target.value)}
            />
            <Button variant="outline" size="sm" onClick={() => void browse()}>
              Browse
            </Button>
          </div>
        </Field>
        <Separator className="my-4" />
        <ToggleRow
          label="Open agent work in tabs"
          description="Open a tab when an agent starts a Fleet task or a thread spawns a subagent. Off by default; watch agent work in each project's Fleet instead. Closing a tab never stops the work."
          checked={autoOpenSpawnedThreads}
          onChange={(v) => setPref("autoOpenSpawnedThreads", v)}
        />
        <Separator />
        <ToggleRow
          label="Require approval before spawning subagents"
          description="Ask before a thread spawns each subagent type. Off by default; spawns proceed without a prompt and you watch or intervene in the project's Fleet. Applies to sessions started after the change."
          checked={requireSubagentApproval}
          onChange={(v) => setPref("requireSubagentApproval", v)}
        />
        <Separator />
        <Field
          label="Max helper subagents at once"
          hint="How many subagents spawned by threads and Fleet agents can run at the same time, across all projects; the rest wait for a free slot. Each Fleet agent's own runs-at-once is set on the Fleet board. Minimum 1."
        >
          <Input
            type="number"
            min={1}
            max={16}
            value={maxConcurrentAgents}
            className="w-24"
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n >= 1) {
                setPref("maxConcurrentAgents", Math.min(16, Math.floor(n)));
              }
            }}
          />
        </Field>
        <Separator />
        <ToggleRow
          label="Keep the computer awake while working"
          description="Prevent the machine from sleeping while a thread is mid-turn, so a long unattended run does not idle-sleep. The display may still dim; an explicit sleep or lid close is never overridden."
          checked={keepAwakeWhileStreaming}
          onChange={(v) => setPref("keepAwakeWhileStreaming", v)}
        />
      </Section>
    </div>
  );
}

// Auto-compaction is a global default (HOY-275): Pi persists it per its own
// settings and defaults it on, but that value is unreachable when the toggle is
// set from Settings with no thread open, so the renderer pref is the source of
// truth. Every session adopts it on spawn (store.applyAutoCompaction). Toggling
// also fans the change out to every already-live session so open conversations
// reflect it at once. The control is therefore always enabled.
function AutoCompactionRow() {
  const autoCompaction = usePrefsStore((s) => s.autoCompaction);
  const setPref = usePrefsStore((s) => s.setPref);
  const setAutoCompaction = useSessionStore((s) => s.setAutoCompaction);

  return (
    <ToggleRow
      label="Auto-compaction"
      description="Automatically summarize older turns as the context window fills, instead of stalling on overflow. Applies to new conversations and any that are open."
      checked={autoCompaction}
      onChange={(v) => {
        setPref("autoCompaction", v);
        // Fan the change out to every live session so open conversations honor
        // it without a reopen. New sessions pick it up on spawn.
        void setAutoCompaction(v);
      }}
    />
  );
}

function MemoryPanel() {
  return (
    <div className="space-y-8">
      <PanelHeader
        title="Memory & Context"
        description="How Hoy manages the conversation's context window."
      />
      <Section title="Context">
        <div className="mt-2">
          <AutoCompactionRow />
        </div>
      </Section>
      <Placeholder
        title="Persistent memory"
        icon={Brain}
        blurb="A cross-session memory so the agent can carry facts and preferences between conversations. Under research (HOY-202)."
        points={[
          "Project-scoped markdown memories",
          "Automatic memory injection into context",
          "A memory tool gated like edit and write",
        ]}
      />
    </div>
  );
}

// The Update object from @tauri-apps/plugin-updater, narrowed to what we use.
interface PendingUpdate {
  version: string;
  body?: string;
  downloadAndInstall: () => Promise<void>;
}

type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "uptodate"
  | "error";

// HOY-187: check-for-updates against GitHub releases. The plugins are dynamically
// imported so no updater code runs in dev, where the check is disabled (the hoyd
// namespace must never check against production releases).
function UpdateCheck() {
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [info, setInfo] = useState<{ version: string; notes?: string } | null>(
    null,
  );
  const [message, setMessage] = useState<string | null>(null);
  const pending = useRef<PendingUpdate | null>(null);

  const onCheck = async () => {
    setStatus("checking");
    setMessage(null);
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (!update) {
        setStatus("uptodate");
        return;
      }
      pending.current = update as unknown as PendingUpdate;
      setInfo({ version: update.version, notes: update.body ?? undefined });
      setStatus("available");
    } catch (e) {
      setMessage(String(e));
      setStatus("error");
    }
  };

  const onInstall = async () => {
    if (!pending.current) return;
    setStatus("downloading");
    setMessage(null);
    try {
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await pending.current.downloadAndInstall();
      await relaunch();
    } catch (e) {
      setMessage(String(e));
      setStatus("error");
    }
  };

  if (import.meta.env.DEV) {
    return (
      <p className="text-xs text-muted-foreground">
        Updates are checked in release builds.
      </p>
    );
  }

  const installing = status === "available" || status === "downloading";
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm">
          {status === "available" && info ? (
            <span>
              Update available:{" "}
              <span className="font-mono text-xs">{info.version}</span>
            </span>
          ) : status === "uptodate" ? (
            <span className="text-muted-foreground">
              You are on the latest version.
            </span>
          ) : status === "error" ? (
            <span className="text-destructive">
              {message ?? "Update check failed."}
            </span>
          ) : (
            <span className="text-muted-foreground">
              Check for a new version.
            </span>
          )}
        </div>
        {installing ? (
          <Button
            size="sm"
            onClick={onInstall}
            disabled={status === "downloading"}
          >
            <Download className="size-4" />
            {status === "downloading" ? "Installing..." : "Install & restart"}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={onCheck}
            disabled={status === "checking"}
          >
            <RefreshCw className="size-4" />
            {status === "checking" ? "Checking..." : "Check for updates"}
          </Button>
        )}
      </div>
      {status === "available" && info?.notes ? (
        <p className="whitespace-pre-line text-xs text-muted-foreground">
          {info.notes}
        </p>
      ) : null}
    </div>
  );
}

function AboutPanel() {
  const [appVersion, setAppVersion] = useState<string | null>(null);

  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion(null));
  }, []);

  return (
    <div className="space-y-8">
      <PanelHeader title="About" />
      <Section>
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center bg-brand/10 text-brand ring-1 ring-inset ring-brand/20">
            <Boxes className="size-5" />
          </div>
          <div>
            <p className="text-sm font-semibold">Hoy</p>
            <p className="text-xs text-muted-foreground">
              Your AI coding companion.
            </p>
          </div>
        </div>
        <Separator className="my-4" />
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Version</dt>
            <dd className="font-mono text-xs">{appVersion ?? "-"}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Pi agent</dt>
            <dd className="font-mono text-xs">{PI_VERSION}</dd>
          </div>
        </dl>
        <Separator className="my-4" />
        <UpdateCheck />
      </Section>

      <Section>
        <div className="mb-3 flex items-center gap-2">
          <Monitor className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Host Computer</h2>
        </div>
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Platform</dt>
            <dd className="font-mono text-xs">{platform()}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Version</dt>
            <dd className="font-mono text-xs">{version()}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Architecture</dt>
            <dd className="font-mono text-xs">{arch()}</dd>
          </div>
        </dl>
      </Section>
    </div>
  );
}

function AppearancePanel() {
  return (
    <div className="space-y-8">
      <PanelHeader
        title="Appearance"
        description="Choose how Hoy renders its local interface."
      />
      <Section
        title="Theme"
        description="Dark remains the default Hoy workbench; light and system use the same token set."
      >
        <div className="mt-4">
          <ThemeSelector />
        </div>
      </Section>
    </div>
  );
}

export function SettingsPanel({ id }: { id: CategoryId }) {
  switch (id) {
    case "model":
      return <ModelsPanel />;
    case "chat":
      return <ChatPanel />;
    case "appearance":
      return <AppearancePanel />;
    case "workspace":
      return <WorkspacePanel />;
    case "safety":
      return (
        <Placeholder
          title="Safety"
          description="Approvals and guardrails for tool execution."
          icon={ShieldCheck}
          blurb="Tool approval is set per conversation from the panel's permission menu today. A global default lives here once it is wired."
          points={[
            "Default approval mode for new threads",
            "Per-tool allow and deny rules",
          ]}
        />
      );
    case "memory":
      return <MemoryPanel />;
    case "voice":
      return (
        <Placeholder
          title="Voice"
          description="Speech-to-text input and spoken replies."
          icon={Mic}
          blurb="Voice input and spoken replies are not built yet."
          points={["Dictate prompts with the microphone", "Read responses aloud"]}
        />
      );
    case "advanced":
      return (
        <Placeholder
          title="Advanced"
          description="Diagnostics and experimental options."
          icon={Wrench}
          blurb="Developer diagnostics need more plumbing before they can be exposed here."
          points={[
            "Developer mode (raw RPC payloads)",
            "Verbose agent logging and log level",
          ]}
        />
      );
    case "providers":
      return <ProvidersPanel />;
    case "gateway":
      return (
        <Placeholder
          title="Gateway"
          description="Route provider requests through a shared gateway."
          icon={Network}
          blurb="A gateway endpoint for routing provider traffic is not built yet."
          points={["Gateway URL and timeout", "Per-provider routing"]}
        />
      );
    case "tools":
      return (
        <Placeholder
          title="Tools & Keys"
          description="Secrets exposed to tools at runtime."
          icon={Wrench}
          blurb="Provider credentials live in the Providers section. A general secrets store for tools (tokens, search keys) is planned."
          points={[
            "Named environment keys for tools",
            "Scope a key to specific tools",
          ]}
        />
      );
    case "mcp":
      return <McpPanel />;
    case "integrations":
      return <IntegrationsPanel />;
    case "subagents":
      return <SubagentsPanel />;
    case "skills":
      return <SkillsPanel />;
    case "archived":
      return (
        <Placeholder
          title="Archived Chats"
          description="Threads you have archived."
          icon={Archive}
          blurb="Archived threads live in the history view for now. A dedicated management surface with restore and delete is planned."
          points={["Unarchive a thread", "Delete permanently"]}
        />
      );
    case "about":
      return <AboutPanel />;
  }
}
