import Link from "next/link";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { HeroStage } from "@/components/HeroStage";
import { RevealOnScroll } from "@/components/RevealOnScroll";
import { PlatformPicker } from "@/components/PlatformPicker";
import {
  AppWindow,
  SidebarBeat,
  ToolCallsBeat,
  ModelBeat,
} from "@/components/AppMock";
import { getLatestVersion } from "@/lib/releases";
import { RELEASES_URL, RELEASES_LATEST_URL } from "@/lib/site";

function AppleIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.53 4.09l.01-.01M12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
    </svg>
  );
}

function LinuxIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l3 3-3 3M13 15h4" />
    </svg>
  );
}

function WindowsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M3 5.6 10.4 4.6v6.7H3zM11.4 4.5 21 3.2v8.1h-9.6zM3 12.7h7.4v6.7L3 18.4zM11.4 12.7H21v8.1l-9.6-1.3z" />
    </svg>
  );
}

// Resolved at build time via the static export; a new GitHub release refreshes
// the displayed version on the next deploy without editing this file.
export default async function Home() {
  const version = await getLatestVersion();

  return (
    <>
      <SiteHeader />

      <main>
        <section className="hero">
          <div className="hero-bg" aria-hidden="true" />
          <div className="wrap-wide">
            <div className="hero-lead">
              <span className="badge">
                <span className="pulse" aria-hidden="true" />
                Beta / Experimental
              </span>
              <h1>Hoy</h1>
              <p className="tagline">
                The Pi coding agent, in a real window. Streaming output, inline
                tool calls, and every session kept.
              </p>

              <div className="cta-row cta-row-center">
                <a className="btn btn-primary" href={RELEASES_LATEST_URL}>
                  Download v{version}
                </a>
                <Link className="btn btn-ghost" href="/changelog">
                  Changelog
                </Link>
              </div>
              <PlatformPicker />
            </div>

            <HeroStage>
              <AppWindow />
            </HeroStage>
          </div>
        </section>

        <section id="how" className="beats">
          <div className="wrap-wide">
            <div className="beats-head">
              <div className="section-head">
                <span className="dot" aria-hidden="true" />
                <h2 className="heading">See it work</h2>
              </div>
              <p className="lead">
                Hoy runs on your machine and talks to the Pi coding agent as a
                separate local process. Your API key stays local and never leaves
                through Hoy.
              </p>
            </div>

            <div className="beat">
              <div className="beat-copy">
                <h3 className="heading">Every session, kept</h3>
                <p className="lead">
                  Projects and threads live in a sidebar that survives restarts.
                  Reopen any conversation exactly where you left it.
                </p>
              </div>
              <RevealOnScroll className="beat-visual">
                <SidebarBeat />
              </RevealOnScroll>
            </div>

            <div className="beat beat-reverse">
              <div className="beat-copy">
                <h3 className="heading">Tool calls, rendered inline</h3>
                <p className="lead">
                  Reads, edits, and shell commands appear in the transcript as the
                  agent runs them, with their results, not walls of raw output.
                </p>
              </div>
              <RevealOnScroll className="beat-visual">
                <ToolCallsBeat />
              </RevealOnScroll>
            </div>

            <div className="beat">
              <div className="beat-copy">
                <h3 className="heading">Any model you have a key for</h3>
                <p className="lead">
                  Bring your own key and switch between Anthropic, OpenAI,
                  DeepSeek, Groq, and more from one picker.
                </p>
              </div>
              <RevealOnScroll className="beat-visual">
                <ModelBeat />
              </RevealOnScroll>
            </div>
          </div>
        </section>

        <section id="install">
          <div className="wrap">
            <div className="section-head">
              <span className="dot" aria-hidden="true" />
              <h2 className="heading">Get running</h2>
            </div>
            <p className="lead">
              Grab the latest build from GitHub Releases, then follow the steps
              for your platform. Current build is v{version}.
            </p>

            <div className="grid">
              <div className="card" id="dl-macos">
                <div className="card-head">
                  <AppleIcon />
                  <h3>macOS</h3>
                  <span className="rec-badge">For you</span>
                </div>
                <ol>
                  <li>
                    Download the <code>.dmg</code> from{" "}
                    <a href={RELEASES_LATEST_URL}>Releases</a>.
                  </li>
                  <li>Open it and drag Hoy to Applications.</li>
                  <li>
                    First launch: right-click the app and choose Open (unsigned
                    build).
                  </li>
                </ol>
              </div>

              <div className="card" id="dl-linux">
                <div className="card-head">
                  <LinuxIcon />
                  <h3>Linux</h3>
                  <span className="rec-badge">For you</span>
                </div>
                <ol>
                  <li>
                    Download the <code>.AppImage</code> or <code>.deb</code> from{" "}
                    <a href={RELEASES_LATEST_URL}>Releases</a>.
                  </li>
                  <li>
                    AppImage: <code>chmod +x</code> it, then run it.
                  </li>
                  <li>
                    Debian/Ubuntu: <code>sudo dpkg -i hoy_*.deb</code>.
                  </li>
                </ol>
              </div>

              <div className="card" id="dl-windows">
                <div className="card-head">
                  <WindowsIcon />
                  <h3>Windows</h3>
                  <span className="rec-badge">For you</span>
                </div>
                <ol>
                  <li>
                    Download the <code>.msi</code> or <code>.exe</code> from{" "}
                    <a href={RELEASES_LATEST_URL}>Releases</a>.
                  </li>
                  <li>Run the installer.</li>
                  <li>
                    SmartScreen warns: choose More info, then Run anyway
                    (unsigned build).
                  </li>
                </ol>
              </div>
            </div>

            <p className="callout">
              <strong>Why the warnings:</strong> Windows and macOS builds are
              currently unsigned, so SmartScreen and Gatekeeper flag them on
              first launch. Code signing is a known pre-1.0 gap; the per-platform
              step above gets you past it.
            </p>

            <div className="cta-row cta-row-loose">
              <a className="btn btn-ghost" href={RELEASES_URL}>
                All releases
              </a>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter version={version} />
    </>
  );
}
