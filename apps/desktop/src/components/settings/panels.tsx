import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Archive,
  Boxes,
  Brain,
  Download,
  Layers,
  Mic,
  Monitor,
  Network,
  Palette,
  RefreshCw,
  ShieldCheck,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { arch, platform, version } from "@tauri-apps/plugin-os";
import { getVersion } from "@tauri-apps/api/app";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { pickDirectory } from "@/lib/ipc";
import type { ModelInfo, ModelRef } from "@/lib/types";
import type { CategoryId } from "./categories";
import { ProvidersPanel } from "./ProvidersPanel";
import { McpPanel } from "./McpPanel";
import { SubagentsPanel } from "./SubagentsPanel";
import { SkillsPanel } from "./SkillsPanel";
import { useSessionStore } from "@/state/store";
import { usePrefsStore } from "@/state/prefs";

// Pinned Pi version (packages/sidecar; see docs/pi-version-bump.md). Surfaced in About.
const PI_VERSION = "0.80.3";

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
// (a preference or a Pi session setting); there are no cosmetic switches.
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

function groupByProvider(models: ModelInfo[]): [string, ModelInfo[]][] {
  const map = new Map<string, ModelInfo[]>();
  for (const m of models) {
    const arr = map.get(m.provider) ?? [];
    arr.push(m);
    map.set(m.provider, arr);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

const MODEL_VALUE_SEP = ":::";

// The auxiliary-model assignments Pi's SDK supports but its RPC does not expose;
// kept as a planned list until a command backs them.
const AUX_TASKS = [
  "Vision (image analysis)",
  "Web extract (page summarization)",
  "Compression (context compaction)",
  "Skills hub (skill search)",
  "Title generation (session titles)",
];

// Model selection is per-session in Pi (set_model), and Pi remembers the last
// pick as the default for new sessions. So the panel drives the ACTIVE session's
// model (which then becomes the default); with no live session it shows the
// current default read-only. This mirrors the session-gated AutoCompaction row.
function ModelPanel() {
  const activeThreadId = useSessionStore((s) => s.activeThreadId);
  const models = useSessionStore((s) => s.models);
  const defaultModel = useSessionStore((s) => s.defaultModel);
  const selectModel = useSessionStore((s) => s.selectModel);
  const selecting = useSessionStore((s) =>
    activeThreadId ? (s.modelSelecting[activeThreadId] ?? false) : false,
  );
  const active = useSessionStore((s) => {
    if (!activeThreadId) return null;
    for (const p of s.projects) {
      const t = p.threads.find((th) => th.id === activeThreadId);
      if (t) return t;
    }
    return null;
  });

  const hasSession = Boolean(active?.sessionId);
  const current = active?.model ?? defaultModel ?? null;
  const grouped = useMemo(() => groupByProvider(models), [models]);

  const nameOf = (ref: ModelRef | null) => {
    if (!ref) return "Not set";
    const m = models.find((x) => x.provider === ref.provider && x.id === ref.id);
    return m?.name ?? ref.id;
  };

  const value = current
    ? `${current.provider}${MODEL_VALUE_SEP}${current.id}`
    : "";

  return (
    <div className="space-y-8">
      <PanelHeader
        title="Model"
        description="The model Hoy uses for conversations."
      />

      <Section>
        {hasSession && models.length > 0 ? (
          <Field
            label="Default model"
            hint="Sets the model for the active conversation and becomes the default for new threads. Switch models any time from the composer's model menu."
          >
            <Select
              value={value}
              disabled={selecting}
              onValueChange={(v) => {
                const [provider, id] = v.split(MODEL_VALUE_SEP);
                if (activeThreadId && provider && id) {
                  void selectModel(activeThreadId, provider, id);
                }
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Choose a model" />
              </SelectTrigger>
              <SelectContent className="scrollbar-thin max-h-[50vh]">
                {grouped.map(([provider, list]) => (
                  <SelectGroup key={provider}>
                    <SelectLabel>{provider}</SelectLabel>
                    {list.map((m) => (
                      <SelectItem
                        key={`${m.provider}:${m.id}`}
                        value={`${m.provider}${MODEL_VALUE_SEP}${m.id}`}
                      >
                        {m.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : (
          <div className="space-y-2">
            <Label>Default model</Label>
            <div className="flex items-center justify-between gap-3 border border-border bg-muted/20 px-3 py-2.5">
              <span className="truncate text-sm">{nameOf(current)}</span>
              {current && (
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  {current.provider}
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {models.length === 0
                ? "Connect a provider in the Providers section, then open a thread to choose a model."
                : "Open a thread to change the model. Hoy remembers your last pick as the default for new threads."}
            </p>
          </div>
        )}
      </Section>

      <div className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold">Auxiliary models</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Helper tasks run on the main model today. Per-task model overrides
            are planned for a future release.
          </p>
        </div>
        <div className="border border-border">
          <p className="bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
            Planned
          </p>
          <ul className="divide-y divide-border">
            {AUX_TASKS.map((t) => (
              <li
                key={t}
                className="flex items-center gap-3 px-3 py-2.5 text-sm text-muted-foreground"
              >
                <Layers className="size-4 shrink-0 text-muted-foreground/50" />
                {t}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function ChatPanel() {
  const sendOnEnter = usePrefsStore((s) => s.sendOnEnter);
  const expandReasoning = usePrefsStore((s) => s.expandReasoning);
  const expandToolDetails = usePrefsStore((s) => s.expandToolDetails);
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
          label="Expand reasoning"
          description="Show model thinking blocks expanded instead of collapsed."
          checked={expandReasoning}
          onChange={(v) => setPref("expandReasoning", v)}
        />
        <Separator />
        <ToggleRow
          label="Expand tool details"
          description="Show tool-use blocks expanded instead of collapsed. When off, each tool is a compact row you click to reveal; tools awaiting approval or showing an error stay open."
          checked={expandToolDetails}
          onChange={(v) => setPref("expandToolDetails", v)}
        />
      </Section>
    </div>
  );
}

function WorkspacePanel() {
  const defaultProjectDir = usePrefsStore((s) => s.defaultProjectDir);
  const confirmCloseStreaming = usePrefsStore((s) => s.confirmCloseStreaming);
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
        description="Defaults for opening projects and closing panels."
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
          label="Confirm before closing a streaming panel"
          description="Ask before closing a thread whose response is still streaming."
          checked={confirmCloseStreaming}
          onChange={(v) => setPref("confirmCloseStreaming", v)}
        />
        <Separator />
        <ToggleRow
          label="Auto-open spawned subagent threads"
          description="Open a panel for each subagent a thread spawns. Off by default; watch spawned agents in FleetView instead (the footer's Fleet button)."
          checked={autoOpenSpawnedThreads}
          onChange={(v) => setPref("autoOpenSpawnedThreads", v)}
        />
        <Separator />
        <ToggleRow
          label="Require approval before spawning subagents"
          description="Ask before a thread spawns each subagent type. Off by default; spawns proceed without a prompt and you watch or intervene in FleetView. Applies to sessions started after the change."
          checked={requireSubagentApproval}
          onChange={(v) => setPref("requireSubagentApproval", v)}
        />
        <Separator />
        <Field
          label="Max concurrent subagents"
          hint="How many spawned subagents stream at once; the rest queue and start as slots free. Minimum 1."
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
// truth. Every session adopts it on spawn (store.applyAutoCompaction); toggling
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

export function SettingsPanel({ id }: { id: CategoryId }) {
  switch (id) {
    case "model":
      return <ModelPanel />;
    case "chat":
      return <ChatPanel />;
    case "appearance":
      return (
        <Placeholder
          title="Appearance"
          description="Theme and visual density."
          icon={Palette}
          blurb="Hoy ships a single dark, square theme for now. Theming is deferred by design; the layered near-black identity is intentional."
          points={["Light theme", "Accent color choice", "Compact density"]}
        />
      );
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
