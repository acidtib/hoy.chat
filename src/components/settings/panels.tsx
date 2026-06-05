import { useState, type ReactNode } from "react";
import { Boxes } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import type { CategoryId } from "./categories";
import { ProvidersPanel } from "./ProvidersPanel";

// Mock catalogs. No IPC: every control here is local state only.
const PROVIDERS = ["Anthropic", "OpenAI", "Google", "OpenRouter", "Groq", "xAI"];
const MODELS = [
  "claude-opus-4.8",
  "claude-sonnet-4.6",
  "gpt-5",
  "gemini-2.5-pro",
  "llama-4-scout",
];

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
    <section className="rounded-lg border border-border bg-card/50 p-5">
      {(title || action) && (
        <div className="flex items-start justify-between gap-3">
          <div>
            {title && <h2 className="text-sm font-semibold">{title}</h2>}
            {description && (
              <p className="mt-1 text-xs text-muted-foreground">{description}</p>
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

function ToggleRow({
  label,
  description,
  defaultChecked = false,
}: {
  label: string;
  description?: string;
  defaultChecked?: boolean;
}) {
  const [checked, setChecked] = useState(defaultChecked);
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {description && (
          <p className="text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      <Switch checked={checked} onCheckedChange={setChecked} />
    </div>
  );
}

function ProviderModelSelect() {
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  return (
    <div className="space-y-3">
      <Select value={provider} onValueChange={setProvider}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder="Provider" />
        </SelectTrigger>
        <SelectContent className="scrollbar-thin max-h-[50vh]">
          {PROVIDERS.map((p) => (
            <SelectItem key={p} value={p}>
              {p}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={model} onValueChange={setModel}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder="Model" />
        </SelectTrigger>
        <SelectContent className="scrollbar-thin max-h-[50vh]">
          {MODELS.map((m) => (
            <SelectItem key={m} value={m}>
              {m}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button size="sm">Apply</Button>
    </div>
  );
}

const AUX_TASKS = [
  { name: "Vision", tag: "Image analysis" },
  { name: "Web extract", tag: "Page summarization" },
  { name: "Compression", tag: "Context compaction" },
  { name: "Skills hub", tag: "Skill search" },
  { name: "Approval", tag: "Smart auto-approve" },
  { name: "MCP", tag: "MCP tool routing" },
  { name: "Title gen", tag: "Session titles" },
];

function ModelPanel() {
  return (
    <div className="space-y-8">
      <PanelHeader title="Model" />
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          Applies to new sessions. Use the model picker in the composer to
          hot-swap the active chat.
        </p>
        <ProviderModelSelect />
      </div>

      <Section
        title="Auxiliary models"
        description="Helper tasks run on the main model by default. Assign a dedicated model to any task to override."
        action={
          <Button variant="ghost" size="sm" className="text-muted-foreground">
            Reset all to main
          </Button>
        }
      >
        <ul className="mt-4 divide-y divide-border">
          {AUX_TASKS.map((task) => (
            <li
              key={task.name}
              className="flex items-center justify-between gap-4 py-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{task.name}</span>
                  <Badge variant="secondary" className="text-muted-foreground">
                    {task.tag}
                  </Badge>
                </div>
                <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                  auto · use main model
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled
                  className="text-muted-foreground"
                >
                  Set to main
                </Button>
                <Button variant="ghost" size="sm">
                  Change
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

function ChatPanel() {
  return (
    <div className="space-y-8">
      <PanelHeader
        title="Chat"
        description="How conversations behave and render."
      />
      <Section>
        <ToggleRow
          label="Stream responses"
          description="Render tokens as they arrive."
          defaultChecked
        />
        <Separator />
        <ToggleRow
          label="Send on Enter"
          description="Enter sends; Shift+Enter inserts a newline."
          defaultChecked
        />
        <Separator />
        <ToggleRow
          label="Show reasoning"
          description="Expand model thinking blocks by default."
        />
      </Section>
      <Section title="Defaults">
        <div className="mt-4">
          <Field label="Auto-scroll" hint="Follow the transcript while streaming.">
            <Select defaultValue="smart">
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="always">Always</SelectItem>
                <SelectItem value="smart">Smart (pause on scroll up)</SelectItem>
                <SelectItem value="never">Never</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
      </Section>
    </div>
  );
}

function AppearancePanel() {
  return (
    <div className="space-y-8">
      <PanelHeader title="Appearance" description="Theme and density." />
      <Section>
        <div className="space-y-4">
          <Field label="Theme">
            <Select defaultValue="dark">
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="system">System</SelectItem>
                <SelectItem value="dark">Dark</SelectItem>
                <SelectItem value="light">Light</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Accent">
            <Select defaultValue="violet">
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="violet">Violet</SelectItem>
                <SelectItem value="blue">Blue</SelectItem>
                <SelectItem value="emerald">Emerald</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Density">
            <Select defaultValue="comfortable">
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="compact">Compact</SelectItem>
                <SelectItem value="comfortable">Comfortable</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
      </Section>
    </div>
  );
}

function WorkspacePanel() {
  return (
    <div className="space-y-8">
      <PanelHeader
        title="Workspace"
        description="Default project and session behavior."
      />
      <Section>
        <Field label="Default project directory" hint="New threads open here.">
          <Input defaultValue="~/Code" spellCheck={false} />
        </Field>
        <div className="mt-4">
          <ToggleRow
            label="Reopen panels on launch"
            description="Restore the last open threads."
          />
          <Separator />
          <ToggleRow
            label="Confirm before closing a streaming panel"
            defaultChecked
          />
        </div>
      </Section>
    </div>
  );
}

function SafetyPanel() {
  return (
    <div className="space-y-8">
      <PanelHeader
        title="Safety"
        description="Approvals and guardrails for tool execution."
      />
      <Section>
        <Field label="Tool approval">
          <Select defaultValue="auto">
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="always">Always ask</SelectItem>
              <SelectItem value="auto">Smart auto-approve</SelectItem>
              <SelectItem value="never">Never ask</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <div className="mt-4">
          <ToggleRow
            label="Allow file writes"
            description="Permit edits outside a dry run."
            defaultChecked
          />
          <Separator />
          <ToggleRow
            label="Allow network access"
            description="Let tools reach the network."
          />
        </div>
      </Section>
    </div>
  );
}

function MemoryPanel() {
  return (
    <div className="space-y-8">
      <PanelHeader
        title="Memory & Context"
        description="What the agent remembers across sessions."
      />
      <Section>
        <ToggleRow
          label="Persistent memory"
          description="Carry facts between sessions."
          defaultChecked
        />
        <Separator />
        <ToggleRow
          label="Auto-compaction"
          description="Compress context as it fills."
          defaultChecked
        />
        <Separator />
        <div className="pt-2">
          <Field
            label="Context window target"
            hint="Compact when usage exceeds this share."
          >
            <Select defaultValue="80">
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="60">60%</SelectItem>
                <SelectItem value="80">80%</SelectItem>
                <SelectItem value="90">90%</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
      </Section>
    </div>
  );
}

function VoicePanel() {
  return (
    <div className="space-y-8">
      <PanelHeader
        title="Voice"
        description="Speech-to-text input and spoken replies."
      />
      <Section>
        <ToggleRow
          label="Voice input"
          description="Dictate prompts with the microphone."
        />
        <Separator />
        <ToggleRow label="Spoken replies" description="Read responses aloud." />
        <div className="mt-4">
          <Field label="Voice">
            <Select defaultValue="aria">
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="aria">Aria</SelectItem>
                <SelectItem value="atlas">Atlas</SelectItem>
                <SelectItem value="nova">Nova</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
      </Section>
    </div>
  );
}

function AdvancedPanel() {
  return (
    <div className="space-y-8">
      <PanelHeader
        title="Advanced"
        description="Diagnostics and experimental options."
      />
      <Section>
        <ToggleRow
          label="Developer mode"
          description="Expose raw RPC payloads and debug actions."
        />
        <Separator />
        <ToggleRow
          label="Verbose sidecar logs"
          description="Write detailed logs to disk."
        />
        <div className="mt-4">
          <Field label="Sidecar log level">
            <Select defaultValue="info">
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="error">Error</SelectItem>
                <SelectItem value="warn">Warn</SelectItem>
                <SelectItem value="info">Info</SelectItem>
                <SelectItem value="debug">Debug</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
      </Section>
    </div>
  );
}

function GatewayPanel() {
  return (
    <div className="space-y-8">
      <PanelHeader
        title="Gateway"
        description="Route requests through a shared gateway."
      />
      <Section>
        <ToggleRow
          label="Use gateway"
          description="Send provider traffic through the gateway endpoint."
        />
        <div className="mt-4 space-y-4">
          <Field label="Gateway URL">
            <Input placeholder="https://gateway.example.com" spellCheck={false} />
          </Field>
          <Field label="Timeout" hint="Connection timeout in milliseconds.">
            <Input defaultValue="15000" inputMode="numeric" />
          </Field>
        </div>
      </Section>
    </div>
  );
}

const MOCK_KEYS = [
  { name: "GITHUB_TOKEN", scope: "git, gh" },
  { name: "TAVILY_API_KEY", scope: "web search" },
];

function ToolsPanel() {
  return (
    <div className="space-y-8">
      <PanelHeader
        title="Tools & Keys"
        description="Secrets exposed to tools at runtime."
      />
      <Section title="Add a key">
        <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_1fr]">
          <Field label="Name">
            <Input placeholder="MY_API_KEY" spellCheck={false} />
          </Field>
          <Field label="Value">
            <Input type="password" placeholder="Paste value" autoComplete="off" />
          </Field>
        </div>
        <div className="mt-5 flex justify-end">
          <Button size="sm">Add key</Button>
        </div>
      </Section>
      <Section title="Stored keys">
        <ul className="mt-4 space-y-2">
          {MOCK_KEYS.map((k) => (
            <li
              key={k.name}
              className="flex items-center justify-between gap-3 rounded-md border border-border bg-card/50 px-4 py-3"
            >
              <div className="min-w-0">
                <p className="truncate font-mono text-sm">{k.name}</p>
                <p className="text-xs text-muted-foreground">{k.scope}</p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-destructive"
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

const MOCK_MCP = [
  { name: "playwright", status: "connected", tools: 24 },
  { name: "context7", status: "connected", tools: 2 },
  { name: "tauri", status: "disconnected", tools: 0 },
];

function McpPanel() {
  return (
    <div className="space-y-8">
      <PanelHeader
        title="MCP"
        description="Model Context Protocol servers and their tools."
      />
      <Section
        title="Servers"
        action={
          <Button variant="outline" size="sm">
            Add server
          </Button>
        }
      >
        <ul className="mt-4 space-y-2">
          {MOCK_MCP.map((s) => (
            <li
              key={s.name}
              className="flex items-center justify-between gap-3 rounded-md border border-border bg-card/50 px-4 py-3"
            >
              <div className="flex min-w-0 items-center gap-3">
                <StatusDot on={s.status === "connected"} />
                <span className="truncate text-sm font-medium">{s.name}</span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge variant="outline" className="text-muted-foreground">
                  {s.status === "connected" ? `${s.tools} tools` : "offline"}
                </Badge>
                <Button variant="ghost" size="sm" className="text-muted-foreground">
                  Configure
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

const MOCK_ARCHIVED = [
  { title: "Refactor the reader thread", project: "hoy", when: "2d ago" },
  { title: "Draft the M5 spec", project: "hoy", when: "1w ago" },
  { title: "Investigate JSONL framing", project: "pi-src", when: "3w ago" },
];

function ArchivedPanel() {
  return (
    <div className="space-y-8">
      <PanelHeader
        title="Archived Chats"
        description="Threads you have archived. Unarchive to restore, or delete permanently."
      />
      <Section>
        <ul className="divide-y divide-border">
          {MOCK_ARCHIVED.map((t) => (
            <li
              key={t.title}
              className="flex items-center justify-between gap-4 py-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{t.title}</p>
                <p className="text-xs text-muted-foreground">
                  {t.project} · {t.when}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button variant="ghost" size="sm" className="text-muted-foreground">
                  Unarchive
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-destructive"
                >
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

function AboutPanel() {
  return (
    <div className="space-y-8">
      <PanelHeader title="About" />
      <Section>
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-md bg-brand/10 text-brand ring-1 ring-inset ring-brand/20">
            <Boxes className="size-5" />
          </div>
          <div>
            <p className="text-sm font-semibold">Hoy</p>
            <p className="text-xs text-muted-foreground">
              A native desktop GUI for the Pi coding agent.
            </p>
          </div>
        </div>
        <Separator className="my-4" />
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Version</dt>
            <dd className="font-mono text-xs">0.1.0</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Pi agent</dt>
            <dd className="font-mono text-xs">0.78.0</dd>
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
      return <AppearancePanel />;
    case "workspace":
      return <WorkspacePanel />;
    case "safety":
      return <SafetyPanel />;
    case "memory":
      return <MemoryPanel />;
    case "voice":
      return <VoicePanel />;
    case "advanced":
      return <AdvancedPanel />;
    case "providers":
      return <ProvidersPanel />;
    case "gateway":
      return <GatewayPanel />;
    case "tools":
      return <ToolsPanel />;
    case "mcp":
      return <McpPanel />;
    case "archived":
      return <ArchivedPanel />;
    case "about":
      return <AboutPanel />;
  }
}
