// A coded depiction of a live Hoy session for the hero. Shows what a static
// screenshot cannot: streaming output, a live reasoning timer, and an inline
// tool call. Mirrors the desktop app's square theme. Motion (caret, pulse) is
// pure CSS and has a prefers-reduced-motion fallback in globals.css.
export function StreamingPreview() {
  return (
    <div
      className="appwin"
      role="img"
      aria-label="A live Hoy session: the user asks to add a health-check endpoint; the agent shows a live reasoning timer, streams its reply, and renders an inline Edit tool call on server.ts."
    >
      <div className="appwin-bar" aria-hidden="true">
        <div className="appwin-dots">
          <i />
          <i />
          <i />
        </div>
        <span className="appwin-title">Hoy, api-server</span>
        <span className="appwin-model">claude-opus-4-8</span>
      </div>
      <div className="appwin-body" aria-hidden="true">
        <div className="appwin-side">
          <span className="active" />
          <span />
          <span />
          <span />
          <span />
        </div>
        <div className="appwin-main">
          <div>
            <div className="chat-role">You</div>
            <div className="chat-user">
              Add a health-check endpoint to the server.
            </div>
          </div>

          <span className="think-pill">
            <span className="pulse" />
            Thought for 2s
          </span>

          <div>
            <div className="chat-role">Hoy</div>
            <div className="chat-asst">
              I&apos;ll add a <code>GET /healthz</code> route that returns 200,
              then wire it into the router
              <span className="caret" />
            </div>
          </div>

          <span className="tool-chip">
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
              <path
                d="M3.5 8.5l3 3 6-7"
                fill="none"
                stroke="#3fb950"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Edit <span className="path">server.ts</span> +12 -0
          </span>
        </div>
      </div>
    </div>
  );
}
