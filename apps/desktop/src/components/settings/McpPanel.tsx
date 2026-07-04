import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Trash2, Cable } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { listMcpServers } from "@/lib/ipc";
import { parseMcpServersJson } from "@/lib/mcpImport";
import type { McpScope, McpServerEntry, McpServerList } from "@/lib/types";
import { useSessionStore } from "@/state/store";
import { cn } from "@/lib/utils";
import { PanelHeader, Section, StatusDot } from "./panels";

// Split a command line into args on whitespace, ignoring empty runs. Good enough
// for the common case; a server needing quoted args can be authored in the file.
function splitArgs(raw: string): string[] {
  return raw.trim().length ? raw.trim().split(/\s+/) : [];
}

// Parse a "KEY=value" per line block into an object; blank lines and lines
// without "=" are skipped.
function parseKeyVals(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const i = line.indexOf("=");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    if (k) out[k] = line.slice(i + 1).trim();
  }
  return out;
}

function transportLabel(t: McpServerEntry["transport"]): string {
  return t === "http" ? "HTTP" : t === "stdio" ? "Command" : "Unknown";
}

// One-line summary of what a server runs or connects to.
function serverDetail(spec: Record<string, unknown>): string {
  if (typeof spec.url === "string") return spec.url;
  const cmd = typeof spec.command === "string" ? spec.command : "";
  const args = Array.isArray(spec.args) ? spec.args.join(" ") : "";
  return [cmd, args].filter(Boolean).join(" ");
}

function ServerRow({
  entry,
  onToggle,
  onRemove,
  readOnly,
  busy,
}: {
  entry: McpServerEntry;
  onToggle?: (next: boolean) => void;
  onRemove?: () => void;
  readOnly?: boolean;
  busy?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <StatusDot on={!entry.disabled} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{entry.name}</span>
          <span className="shrink-0 border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            {transportLabel(entry.transport)}
          </span>
        </div>
        <p className="truncate font-mono text-xs text-muted-foreground">
          {serverDetail(entry.spec) || "(no command)"}
        </p>
      </div>
      {readOnly ? (
        <span className="shrink-0 text-xs text-muted-foreground">read-only</span>
      ) : (
        <>
          <Switch
            checked={!entry.disabled}
            disabled={busy}
            onCheckedChange={(v) => onToggle?.(v)}
            aria-label={entry.disabled ? "Enable server" : "Disable server"}
          />
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
            disabled={busy}
            onClick={onRemove}
            aria-label="Remove server"
          >
            <Trash2 className="size-4" />
          </Button>
        </>
      )}
    </div>
  );
}

function AddServerForm({
  onAdd,
  busy,
}: {
  onAdd: (name: string, spec: Record<string, unknown>) => Promise<void>;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"form" | "json">("form");
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "http">("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [extra, setExtra] = useState(""); // env (stdio) or headers (http), KEY=value lines
  const [json, setJson] = useState("");
  const [error, setError] = useState<string | null>(null);

  const valid =
    mode === "json"
      ? json.trim().length > 0
      : name.trim() && (transport === "stdio" ? command.trim() : url.trim());

  function reset() {
    setName("");
    setCommand("");
    setArgs("");
    setUrl("");
    setExtra("");
    setJson("");
    setError(null);
    setTransport("stdio");
    setMode("form");
  }

  async function submit() {
    if (!valid) return;
    // JSON-paste path (HOY-273): parse the standard mcpServers config into one or
    // more (name, spec) pairs and add each; the typed Name is the fallback for a
    // single unnamed server. Parse errors surface before any server is added.
    if (mode === "json") {
      let servers;
      try {
        servers = parseMcpServersJson(json, name);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return;
      }
      try {
        setError(null);
        for (const s of servers) await onAdd(s.name, s.spec);
        reset();
        setOpen(false);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    const spec: Record<string, unknown> =
      transport === "stdio"
        ? { command: command.trim(), ...(splitArgs(args).length ? { args: splitArgs(args) } : {}) }
        : { url: url.trim() };
    const kv = parseKeyVals(extra);
    if (Object.keys(kv).length) {
      if (transport === "stdio") spec.env = kv;
      else spec.headers = kv;
    }
    try {
      setError(null);
      await onAdd(name.trim(), spec);
      reset();
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (!open) {
    return (
      <Button variant="outline" className="w-full" onClick={() => setOpen(true)}>
        <Plus className="mr-2 size-4" />
        Add server
      </Button>
    );
  }

  return (
    <div className="space-y-4 border border-border bg-card/40 p-4">
      <div className="inline-flex rounded-md border border-border p-0.5">
        {(["form", "json"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => {
              setMode(m);
              setError(null);
            }}
            className={cn(
              "rounded-sm px-2.5 py-1 text-xs font-medium transition-colors",
              mode === m
                ? "bg-secondary text-secondary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {m === "form" ? "Form" : "Paste JSON"}
          </button>
        ))}
      </div>

      {mode === "json" ? (
        <>
          <div className="space-y-2">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="linear" />
            <p className="text-xs text-muted-foreground">
              Optional — only used when the JSON is a single server with no name.
            </p>
          </div>
          <div className="space-y-2">
            <Label>Config JSON</Label>
            <textarea
              value={json}
              onChange={(e) => setJson(e.target.value)}
              rows={9}
              spellCheck={false}
              autoFocus
              className="w-full resize-y border border-input bg-transparent px-3 py-2 font-mono text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
              placeholder={
                '{\n  "mcpServers": {\n    "linear": {\n      "command": "bunx",\n      "args": ["-y", "mcp-remote", "https://mcp.linear.app/mcp"]\n    }\n  }\n}'
              }
            />
            <p className="text-xs text-muted-foreground">
              Paste a standard MCP config. Accepts the <code>mcpServers</code> wrapper, a
              name→server map, or a single server object; adds every server it finds.
            </p>
          </div>
        </>
      ) : (
        <>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label>Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="linear" autoFocus />
        </div>
        <div className="space-y-2">
          <Label>Transport</Label>
          <Select value={transport} onValueChange={(v) => setTransport(v as "stdio" | "http")}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="stdio">Command (stdio)</SelectItem>
              <SelectItem value="http">URL (http)</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {transport === "stdio" ? (
        <>
          <div className="space-y-2">
            <Label>Command</Label>
            <Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="bunx" />
          </div>
          <div className="space-y-2">
            <Label>Arguments</Label>
            <Input
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder="-y mcp-remote https://mcp.linear.app/mcp"
            />
            <p className="text-xs text-muted-foreground">Space-separated.</p>
          </div>
        </>
      ) : (
        <div className="space-y-2">
          <Label>URL</Label>
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" />
        </div>
      )}

      <div className="space-y-2">
        <Label>{transport === "stdio" ? "Environment" : "Headers"}</Label>
        <textarea
          value={extra}
          onChange={(e) => setExtra(e.target.value)}
          rows={2}
          spellCheck={false}
          className="w-full resize-y border border-input bg-transparent px-3 py-2 font-mono text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
          placeholder={"TOKEN=${LINEAR_TOKEN}"}
        />
        <p className="text-xs text-muted-foreground">
          One KEY=value per line. Use ${"{VAR}"} to reference an environment variable instead of inlining a secret.
        </p>
      </div>
        </>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          onClick={() => {
            reset();
            setOpen(false);
          }}
          disabled={busy}
        >
          Cancel
        </Button>
        <Button onClick={submit} disabled={!valid || busy}>
          Add server
        </Button>
      </div>
    </div>
  );
}

function ServerList({ children }: { children: React.ReactNode }) {
  return <div className="divide-y divide-border border border-border">{children}</div>;
}

export function McpPanel() {
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const projects = useSessionStore((s) => s.projects);
  const saveMcpServer = useSessionStore((s) => s.saveMcpServer);
  const removeMcpServer = useSessionStore((s) => s.removeMcpServer);

  const projectPath = useMemo(
    () => projects.find((p) => p.id === activeProjectId)?.path ?? null,
    [projects, activeProjectId],
  );

  const [list, setList] = useState<McpServerList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      setList(await listMcpServers(projectPath));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [projectPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      try {
        await fn();
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const add = (scope: McpScope) => (name: string, spec: Record<string, unknown>) =>
    run(() => saveMcpServer(scope, name, spec, projectPath));

  const toggle = (scope: McpScope, entry: McpServerEntry, next: boolean) =>
    run(() => {
      const spec = { ...entry.spec };
      if (next) delete spec.disabled;
      else spec.disabled = true;
      return saveMcpServer(scope, entry.name, spec, projectPath);
    });

  const remove = (scope: McpScope, name: string) =>
    run(() => removeMcpServer(scope, name, projectPath));

  return (
    <div className="space-y-8">
      <PanelHeader
        title="MCP"
        description="Model Context Protocol servers expose extra tools to the agent. Adding a server lets it run a command or reach a URL, so each is started only after you approve it."
      />

      {error && (
        <Section>
          <p className="text-sm text-destructive">{error}</p>
        </Section>
      )}

      <div className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold">Global</h2>
          <p className="text-xs text-muted-foreground">
            Available in every project. Stored in the Hoy agent directory.
          </p>
        </div>
        {list && list.global.length > 0 && (
          <ServerList>
            {list.global.map((e) => (
              <ServerRow
                key={e.name}
                entry={e}
                busy={busy}
                onToggle={(v) => toggle("global", e, v)}
                onRemove={() => remove("global", e.name)}
              />
            ))}
          </ServerList>
        )}
        <AddServerForm onAdd={add("global")} busy={busy} />
      </div>

      <div className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold">This project</h2>
          <p className="text-xs text-muted-foreground">
            {projectPath
              ? "Only for the active project. Stored in its .hoy/mcp.json."
              : "Open a project to add servers scoped to it."}
          </p>
        </div>
        {projectPath && (
          <>
            {list && list.project.length > 0 && (
              <ServerList>
                {list.project.map((e) => (
                  <ServerRow
                    key={e.name}
                    entry={e}
                    busy={busy}
                    onToggle={(v) => toggle("project", e, v)}
                    onRemove={() => remove("project", e.name)}
                  />
                ))}
              </ServerList>
            )}
            <AddServerForm onAdd={add("project")} busy={busy} />
          </>
        )}
      </div>

      {list && list.projectShared.length > 0 && (
        <div className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold">From this project's .mcp.json</h2>
            <p className="text-xs text-muted-foreground">
              The standard file shared with other MCP tools. The agent uses these; edit the file directly to change them.
            </p>
          </div>
          <ServerList>
            {list.projectShared.map((e) => (
              <ServerRow key={e.name} entry={e} readOnly />
            ))}
          </ServerList>
        </div>
      )}

      {!list && !error && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Cable className="size-4" />
          Loading servers...
        </p>
      )}
    </div>
  );
}
