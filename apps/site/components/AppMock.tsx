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

// Provider brand marks (LobeHub icons, MIT), matching the app's ThreadModelIcon
// (HOY-267): each thread row leads with its model's provider glyph so rows are
// distinguishable at a glance instead of all sharing one star. Filled, rendered
// in currentColor so they inherit the row's muted/active color like the star did.
const PROVIDER_GLYPH: Record<string, string> = {
  deepseek:
    '<path d="M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z"></path>',
  anthropic:
    '<path d="M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017l-1.344 3.46H0L6.57 3.522zm4.132 9.959L8.453 7.687 6.205 13.48H10.7z"></path>',
  openai:
    '<path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z"></path>',
  gemini:
    '<path d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z"></path>',
};

function ProviderGlyph({
  slug,
  size = 14,
  className,
}: {
  slug: keyof typeof PROVIDER_GLYPH;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: PROVIDER_GLYPH[slug] }}
    />
  );
}

const THREADS: {
  title: string;
  time: string;
  provider: keyof typeof PROVIDER_GLYPH;
  active?: boolean;
}[] = [
  { title: "Add /healthz endpoint", time: "now", provider: "deepseek", active: true },
  { title: "Refactor the auth guard", time: "2h", provider: "anthropic" },
  { title: "Fix JSONL U+2028 framing", time: "1d", provider: "openai" },
  { title: "Bump deps to latest", time: "2d", provider: "gemini" },
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
            <ProviderGlyph
              slug={t.provider}
              size={13}
              className="aw-thread-spark"
            />
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
            DeepSeek V4 Flash
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
