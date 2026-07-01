// Coded simulations of the Hoy desktop UI, used as the site's product imagery.
// Fully rendered in the browser (no screenshots), so they always look
// intentional and stay in sync with the app's square, dark identity. Everything
// here is decorative: the whole window carries a single role="img" + aria-label
// and the internals are aria-hidden.

function Check() {
  return (
    <svg
      className="tick"
      viewBox="0 0 16 16"
      width="12"
      height="12"
      aria-hidden="true"
    >
      <path
        d="M3.5 8.5l3 3 6-7"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Dots() {
  return (
    <div className="appwin-dots">
      <i />
      <i />
      <i />
    </div>
  );
}

const THREADS: { title: string; time: string; active?: boolean }[] = [
  { title: "Add /healthz endpoint", time: "now", active: true },
  { title: "Refactor the auth guard", time: "2h" },
  { title: "Fix JSONL U+2028 framing", time: "1d" },
  { title: "Bump Pi to 0.80.3", time: "2d" },
];

function Sidebar() {
  return (
    <aside className="ui-side">
      <div className="ui-search">Search threads</div>
      <div className="ui-proj">
        <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
          <path
            d="M4 6l4 4 4-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        hoy
      </div>
      {THREADS.map((t) => (
        <div
          key={t.title}
          className={t.active ? "ui-thread ui-thread-active" : "ui-thread"}
        >
          <span className="ui-thread-title">{t.title}</span>
          <span className="ui-thread-time">{t.time}</span>
        </div>
      ))}
    </aside>
  );
}

export function AppWindow() {
  return (
    <div
      className="appwin appwin-hero"
      role="img"
      aria-label="The Hoy desktop app: a project sidebar with several coding sessions on the left, and an open thread where the user asks to add a health-check endpoint. The agent shows a live reasoning timer, streams a reply with a code block, and renders an inline Edit tool call on server.ts."
    >
      <div className="appwin-bar" aria-hidden="true">
        <Dots />
        <span className="appwin-title">Hoy</span>
        <span className="appwin-model">claude-opus-4-8</span>
      </div>
      <div className="appwin-body appwin-body-hero" aria-hidden="true">
        <Sidebar />
        <div className="ui-convo">
          <div className="ui-transcript">
            <div className="ui-turn ui-turn-user">
              <div className="chat-user">
                Add a health-check endpoint to the server.
              </div>
            </div>
            <div className="ui-turn">
              <div className="chat-role">Hoy</div>
              <span className="think-pill">
                <span className="pulse" />
                Thought for 2s
              </span>
              <p className="chat-asst">
                Adding a <code>GET /healthz</code> route that returns 200, then
                wiring it into the router:
              </p>
              <pre className="ui-code">
                <code>{`app.get("/healthz", (_req, res) => {
  res.status(200).json({ ok: true });
});`}</code>
              </pre>
              <span className="tool-chip">
                <Check /> Edit <span className="path">server.ts</span> +12 -0
              </span>
              <p className="chat-asst">
                Done, the endpoint is live and returns{" "}
                <code>{`{ ok: true }`}</code>
                <span className="caret" />
              </p>
            </div>
          </div>
          <div className="ui-composer">
            <span className="ui-composer-input">Message Hoy</span>
            <span className="ui-send" aria-hidden="true">
              <svg viewBox="0 0 16 16" width="14" height="14">
                <path
                  d="M2.5 8h9M8 4.5l3.5 3.5L8 11.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function SidebarBeat() {
  return (
    <div
      className="appwin appwin-beat beat-side"
      role="img"
      aria-label="Hoy's sidebar listing coding sessions under the hoy project, with the active session highlighted."
    >
      <div className="appwin-bar" aria-hidden="true">
        <Dots />
        <span className="appwin-title">Sessions</span>
      </div>
      <div className="beat-body" aria-hidden="true">
        <Sidebar />
      </div>
    </div>
  );
}

const TOOLS: { verb: string; path: string; meta: string }[] = [
  { verb: "Read", path: "src/server.ts", meta: "" },
  { verb: "Edit", path: "src/server.ts", meta: "+12 -0" },
  { verb: "Bash", path: "bun test", meta: "51 passed" },
];

export function ToolCallsBeat() {
  return (
    <div
      className="appwin appwin-beat"
      role="img"
      aria-label="A Hoy thread showing three tool calls rendered inline: reading a file, editing it, and running the test suite, which passes."
    >
      <div className="appwin-bar" aria-hidden="true">
        <Dots />
        <span className="appwin-title">Add /healthz endpoint</span>
      </div>
      <div className="beat-body beat-transcript" aria-hidden="true">
        {TOOLS.map((t) => (
          <span key={t.verb} className="tool-chip">
            <Check /> {t.verb} <span className="path">{t.path}</span>
            {t.meta && <span className="tool-meta">{t.meta}</span>}
          </span>
        ))}
        <p className="chat-asst">
          All tests pass. The health check is wired in and covered.
          <span className="caret" />
        </p>
      </div>
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
      <div className="appwin-bar" aria-hidden="true">
        <Dots />
        <span className="appwin-title">Select model</span>
      </div>
      <ul className="mp-list" aria-hidden="true">
        {MODELS.map((m) => (
          <li
            key={m.name}
            className={m.active ? "mp-item mp-item-active" : "mp-item"}
          >
            <span className="mp-name">{m.name}</span>
            <span className="mp-prov">{m.prov}</span>
            {m.active && <Check />}
          </li>
        ))}
      </ul>
    </div>
  );
}
