// Coded simulations of the Hoy desktop UI, used as the site's product imagery.
// Fully rendered in the browser (no screenshots), so they always look
// intentional and track the real app's layout: a Zed-style split where the
// sidebar owns the top-left corner, a title bar (project + branch) over the main
// column, a per-thread header, the transcript, a composer whose pill row carries
// the model selector, and a full-width context/cost status bar along the bottom.
// Everything here is decorative: the window carries one role="img" + aria-label
// and the internals are aria-hidden.

// Lucide-derived glyphs. Inner paths are static literals (no user input), kept as
// strings so the icon set stays compact.
const PATHS: Record<string, string> = {
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  gitBranch:
    '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  barChart3:
    '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
  bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  settings:
    '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  minus: '<path d="M5 12h14"/>',
  square: '<rect width="16" height="16" x="4" y="4" rx="1.5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  atSign:
    '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94"/>',
  send:
    '<path d="M3.7 3.05a.5.5 0 0 0-.68.63l2.84 7.62a2 2 0 0 1 0 1.4l-2.84 7.62a.5.5 0 0 0 .68.63l18-8.5a.5.5 0 0 0 0-.9z"/><path d="M6 12h16"/>',
  panelLeft:
    '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m16 15-3-3 3-3"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  folderPlus:
    '<path d="M12 10v6"/><path d="M9 13h6"/><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  filePen:
    '<path d="M12.5 22H18a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v10"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10.42 12.61a2.1 2.1 0 1 1 2.97 2.97L7.95 21 4 22l.99-3.95z"/>',
  maximize:
    '<path d="M15 3h6v6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/><path d="M9 21H3v-6"/>',
  more:
    '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  listTree:
    '<path d="M21 12h-8"/><path d="M21 6H8"/><path d="M21 18h-8"/><path d="M3 6v4c0 1.1.9 2 2 2h3"/><path d="M3 10v6c0 1.1.9 2 2 2h3"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
};

// Sparkle is filled, so it lives apart from the stroked set.
const SPARKLE =
  "M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0L14.06 8.5A2 2 0 0 0 15.5 9.94l6.14 1.58a.5.5 0 0 1 0 .96L15.5 14.06a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z";

function Ic({
  name,
  size = 14,
  className,
}: {
  name: keyof typeof PATHS;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: PATHS[name] }}
    />
  );
}

function Sparkle({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d={SPARKLE} />
    </svg>
  );
}

const THREADS: { title: string; time: string; active?: boolean }[] = [
  { title: "Add /healthz endpoint", time: "now", active: true },
  { title: "Refactor the auth guard", time: "2h" },
  { title: "Fix JSONL U+2028 framing", time: "1d" },
  { title: "Bump deps to latest", time: "2d" },
];

function Sidebar() {
  return (
    <aside className="aw-side">
      <div className="aw-search">
        <Ic name="search" size={13} />
        <span>Search threads...</span>
      </div>
      <div className="aw-proj">
        <Ic name="chevronDown" size={13} className="aw-proj-chev" />
        <span>hoy</span>
      </div>
      <div className="aw-threads">
        {THREADS.map((t) => (
          <div
            key={t.title}
            className={t.active ? "aw-thread aw-thread-active" : "aw-thread"}
          >
            <Sparkle size={13} className="aw-thread-spark" />
            <span className="aw-thread-body">
              <span className="aw-thread-title">{t.title}</span>
              <span className="aw-thread-time">{t.time}</span>
            </span>
          </div>
        ))}
      </div>
    </aside>
  );
}

// Session-tree rows for the `/tree` navigator (right dock). A linear spine of the
// current thread, ending on the active leaf, plus one forked line branched off it.
type TreeNodeData = {
  role: keyof typeof PATHS;
  label: string;
  preview: string;
  tools?: boolean;
  active?: boolean;
};

const TREE_NODES: TreeNodeData[] = [
  { role: "user", label: "You", preview: "Add a health-check endpoint to the server" },
  { role: "bot", label: "Agent", preview: "Planning the route and where to wire it in" },
  { role: "bot", label: "Agent", preview: "Editing server.ts", tools: true },
  { role: "bot", label: "Agent", preview: "Running the test suite", tools: true },
  { role: "bot", label: "Agent", preview: "Endpoint is live, returns { ok: true }", active: true },
];

const TREE_BRANCH: TreeNodeData = {
  role: "bot",
  label: "Agent",
  preview: "Explore: add rate limiting",
};

function TreeNode({ node }: { node: TreeNodeData }) {
  return (
    <div className={node.active ? "aw-tnode aw-tnode-active" : "aw-tnode"}>
      {node.active && <span className="aw-tnode-bar" aria-hidden />}
      <Ic name={node.role} size={13} className="aw-tnode-icon" />
      <span className="aw-tnode-body">
        <span className="aw-tnode-top">
          <span className="aw-tnode-role">{node.label}</span>
          {node.tools && <span className="aw-tnode-tools">+tools</span>}
          {node.active && <span className="aw-tnode-badge">active</span>}
        </span>
        <span className="aw-tnode-preview">{node.preview}</span>
      </span>
    </div>
  );
}

// The tree spine + one branched child (indented, with a connector), shared by the
// hero dock and the standalone beat.
function TreeList() {
  return (
    <div className="aw-tree">
      {TREE_NODES.map((n) => (
        <TreeNode key={n.preview} node={n} />
      ))}
      <div className="aw-tbranch">
        <TreeNode node={TREE_BRANCH} />
      </div>
    </div>
  );
}

const TREE_FILTERS = ["Default", "No tools", "User", "Labeled", "All"];

// The right-side `/tree` dock as it sits open beside a thread in the hero window.
function TreeDock() {
  return (
    <aside className="aw-dock" aria-hidden="true">
      <div className="aw-dock-head">
        <div className="aw-dock-titlerow">
          <Ic name="listTree" size={14} className="aw-dock-icon" />
          <span className="aw-dock-title">Tree</span>
          <span className="aw-dock-tools">
            <span className="aw-winbtn">
              <Ic name="maximize" size={13} />
            </span>
            <span className="aw-winbtn">
              <Ic name="x" size={14} />
            </span>
          </span>
        </div>
        <p className="aw-dock-sub">
          <span className="aw-dock-sub-lead">Branch a new line of thought</span> from
          any point.
        </p>
        <div className="aw-dock-filters">
          {TREE_FILTERS.map((f, i) => (
            <span
              key={f}
              className={i === 0 ? "aw-dfilter aw-dfilter-active" : "aw-dfilter"}
            >
              {f}
            </span>
          ))}
        </div>
      </div>
      <TreeList />
    </aside>
  );
}

// The composer's bottom pill row, where the model selector actually lives.
function Composer() {
  return (
    <div className="aw-composer">
      <div className="aw-composer-input">
        Message &nbsp;&middot;&nbsp; @ to include context, / for commands
      </div>
      <div className="aw-composer-bar">
        <div className="aw-composer-left">
          <span className="aw-iconbtn">
            <Ic name="atSign" />
          </span>
        </div>
        <div className="aw-composer-right">
          <span className="aw-pill aw-pill-opt">
            Default
            <Ic name="chevronDown" size={11} />
          </span>
          <span className="aw-pill aw-pill-model">
            deepseek-v4
            <Ic name="chevronDown" size={11} />
          </span>
          <span className="aw-pill aw-pill-opt">
            High
            <Ic name="chevronDown" size={11} />
          </span>
          <span className="aw-send">
            <Ic name="send" />
          </span>
        </div>
      </div>
    </div>
  );
}

function EditToolCard() {
  return (
    <div className="aw-tool">
      <div className="aw-tool-head">
        <Ic name="filePen" size={13} className="aw-tool-icon" />
        <span className="aw-tool-title">Edit</span>
        <span className="aw-tool-path">server.ts</span>
        <span className="aw-tool-stat">+12 -0</span>
      </div>
      <pre className="aw-diff">
        <span className="add">+ app.get(&quot;/healthz&quot;, (_req, res) =&gt; {"{"}</span>
        <span className="add">+ &nbsp;&nbsp;res.status(200).json({"{"} ok: true {"}"});</span>
        <span className="add">+ {"}"});</span>
      </pre>
    </div>
  );
}

export function AppWindow() {
  return (
    <div
      className="appwin appwin-hero"
      role="img"
      aria-label="The Hoy desktop app: a project sidebar of threads on the left, a title bar showing the hoy project on the main branch, and an open thread where the user asks to add a health-check endpoint. The agent shows a collapsed reasoning line, streams a reply with an inline Edit tool call and diff on server.ts, and a composer at the bottom with the deepseek-v4 model selected. On the right, the Tree navigator is open, listing the thread's turns with the active leaf highlighted and a branched line below it. A status bar shows context usage and cost."
    >
      <div className="aw-main" aria-hidden="true">
        <Sidebar />

        <div className="aw-body">
          {/* Title bar spans the main body AND the right dock (Zed-style): the
              left threads sidebar keeps the top-left corner, but the tree dock
              sits below this bar, so the window controls own the top-right. */}
          <div className="aw-titlebar">
            <div className="aw-tb-left">
              <span className="aw-tb-project">hoy</span>
              <span className="aw-branch">
                <Ic name="gitBranch" size={12} />
                main
              </span>
            </div>
            <div className="aw-tb-right">
              <span className="aw-winbtn">
                <Ic name="barChart3" size={14} />
              </span>
              <span className="aw-winbtn">
                <Ic name="bot" size={14} />
              </span>
              <span className="aw-winbtn">
                <Ic name="settings" size={14} />
              </span>
              <span className="aw-tb-divider" aria-hidden />
              <span className="aw-winbtn">
                <Ic name="minus" size={14} />
              </span>
              <span className="aw-winbtn">
                <Ic name="square" size={12} />
              </span>
              <span className="aw-winbtn">
                <Ic name="x" size={14} />
              </span>
            </div>
          </div>

          <div className="aw-body-row">
            <div className="aw-col">
              <div className="aw-threadbar">
                <div className="aw-tb-left">
                  <Sparkle size={14} className="aw-threadbar-spark" />
                  <span className="aw-threadbar-title">Add /healthz endpoint</span>
                </div>
                <div className="aw-actions">
                  <span className="aw-winbtn">
                    <Ic name="plus" size={14} />
                  </span>
                  <span className="aw-winbtn">
                    <Ic name="maximize" size={13} />
                  </span>
                  <span className="aw-winbtn">
                    <Ic name="more" size={14} />
                  </span>
                  <span className="aw-winbtn">
                    <Ic name="minus" size={14} />
                  </span>
                </div>
              </div>

              <div className="aw-transcript">
                <div className="aw-msg-user">
                  Add a health-check endpoint to the server.
                </div>

                <div className="aw-msg">
                  <div className="aw-reason">
                    <Ic name="chevronRight" size={13} />
                    Thought for 2s
                  </div>
                  <p className="aw-msg-text">
                    Adding a <code>GET /healthz</code> route that returns 200, then
                    wiring it into the router:
                  </p>
                  <EditToolCard />
                  <p className="aw-msg-text">
                    Done, the endpoint is live and returns{" "}
                    <code>{`{ ok: true }`}</code>
                    <span className="caret" />
                  </p>
                </div>
              </div>

              <Composer />
            </div>

            <TreeDock />
          </div>
        </div>
      </div>

      <div className="aw-status" aria-hidden="true">
        <div className="aw-status-side">
          <span className="aw-statbtn">
            <Ic name="panelLeft" size={14} />
          </span>
          <span className="aw-statbtn">
            <Ic name="clock" size={14} />
          </span>
          <span className="aw-statbtn aw-statbtn-end">
            <Ic name="folderPlus" size={14} />
          </span>
        </div>
        <div className="aw-status-main">
          <span>ctx 18.2k/200k &middot; 9%</span>
          <span className="aw-status-div" />
          <span>$0.0042</span>
        </div>
        <div className="aw-status-right">
          <span className="aw-statbtn aw-statbtn-on">
            <Ic name="listTree" size={14} />
          </span>
        </div>
      </div>
    </div>
  );
}

export function SidebarBeat() {
  return (
    <div
      className="appwin appwin-beat"
      role="img"
      aria-label="Hoy's sidebar listing threads under the hoy project, each with a relative timestamp, with the active thread highlighted."
    >
      <div className="aw-cap" aria-hidden="true">
        Threads
      </div>
      <div className="aw-beat-body" aria-hidden="true">
        <Sidebar />
      </div>
    </div>
  );
}

export function ToolCallsBeat() {
  return (
    <div
      className="appwin appwin-beat"
      role="img"
      aria-label="A Hoy thread showing tool calls rendered inline as bordered cards: an edit to server.ts with a diff, and a shell command running the test suite, which passes."
    >
      <div className="aw-cap aw-cap-thread" aria-hidden="true">
        <Sparkle size={13} className="aw-threadbar-spark" />
        Add /healthz endpoint
      </div>
      <div className="aw-beat-body aw-beat-pad" aria-hidden="true">
        <EditToolCard />
        <div className="aw-tool">
          <div className="aw-tool-head">
            <Ic name="clock" size={13} className="aw-tool-icon" />
            <span className="aw-tool-title">Terminal</span>
            <span className="aw-tool-path">bun test</span>
          </div>
          <pre className="aw-diff aw-term">
            <span className="aw-term-cmd">
              <span className="aw-term-dollar">$</span> bun test
            </span>
            <span>51 pass, 0 fail</span>
          </pre>
        </div>
        <p className="aw-msg-text">
          All tests pass. The health check is wired in and covered.
          <span className="caret" />
        </p>
      </div>
    </div>
  );
}

export function TreeBeat() {
  return (
    <div
      className="appwin appwin-beat"
      role="img"
      aria-label="Hoy's Tree navigator: the thread's turns listed as a spine, each labeled by role, with the active leaf highlighted and one line branched off it into a separate exploration."
    >
      <div className="aw-cap" aria-hidden="true">
        <Ic name="listTree" size={14} className="aw-cap-tree-icon" />
        Tree
      </div>
      <div className="aw-beat-body aw-beat-tree" aria-hidden="true">
        <TreeList />
      </div>
    </div>
  );
}

const FLEET: { title: string; status: "done" | "running" | "queued" }[] = [
  { title: "Explore: map the auth flow", status: "done" },
  { title: "Edit: extract the route guard", status: "running" },
  { title: "Test: cover the new guard", status: "running" },
  { title: "Review: read the final diff", status: "queued" },
];

const FLEET_STATUS: Record<(typeof FLEET)[number]["status"], string> = {
  done: "done",
  running: "running",
  queued: "queued",
};

export function FleetBeat() {
  return (
    <div
      className="appwin appwin-beat"
      role="img"
      aria-label="Hoy's FleetView: a plan handed off to a team of agents running in parallel. One has finished mapping the auth flow, two are editing and testing, and one is queued to review the diff."
    >
      <div className="aw-cap aw-cap-thread" aria-hidden="true">
        <Sparkle size={13} className="aw-fleet-spark" />
        FleetView
        <span className="aw-fleet-roll">2 running &middot; 1 done &middot; 1 queued</span>
      </div>
      <ul className="aw-fleet-list" aria-hidden="true">
        {FLEET.map((m) => (
          <li key={m.title} className="aw-fleet-item">
            <span className={`aw-fleet-dot aw-fleet-${m.status}`} />
            <span className="aw-fleet-title">{m.title}</span>
            <span className={`aw-fleet-tag aw-fleet-tag-${m.status}`}>
              {FLEET_STATUS[m.status]}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const MODELS: { name: string; prov: string; active?: boolean }[] = [
  { name: "Claude Opus 4.8", prov: "Anthropic", active: true },
  { name: "Claude Sonnet 5", prov: "Anthropic" },
  { name: "GPT-5", prov: "OpenAI" },
  { name: "DeepSeek V4 Flash", prov: "DeepSeek" },
  { name: "Qwen3 32B", prov: "Groq" },
];

export function ModelBeat() {
  return (
    <div
      className="appwin appwin-beat beat-models"
      role="img"
      aria-label="Hoy's model selector open, listing models from Anthropic, OpenAI, DeepSeek, and Groq, with Claude Opus 4.8 selected."
    >
      <div className="aw-cap" aria-hidden="true">
        Select model
      </div>
      <ul className="mp-list" aria-hidden="true">
        {MODELS.map((m) => (
          <li
            key={m.name}
            className={m.active ? "mp-item mp-item-active" : "mp-item"}
          >
            <span className="mp-name">{m.name}</span>
            <span className="mp-prov">{m.prov}</span>
            {m.active && <Ic name="check" size={14} className="tick" />}
          </li>
        ))}
      </ul>
    </div>
  );
}
