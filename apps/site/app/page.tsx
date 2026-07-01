import Link from "next/link";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { HeroStage } from "@/components/HeroStage";
import { RevealOnScroll } from "@/components/RevealOnScroll";
import { PlatformPicker } from "@/components/PlatformPicker";
import { HeroDownload } from "@/components/HeroDownload";
import { InstallPanel } from "@/components/InstallPanel";
import {
  AppWindow,
  SidebarBeat,
  ToolCallsBeat,
  ModelBeat,
} from "@/components/AppMock";
import { getLatestVersion } from "@/lib/releases";

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
              <h1>Hoy Chat</h1>
              <p className="tagline">
                The Pi coding agent, in a real window. Streaming output, inline
                tool calls, and every session kept.
              </p>

              <div className="cta-row cta-row-center">
                <HeroDownload version={version} />
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

        <section id="install">
          <div className="wrap">
            <div className="section-head">
              <h2 className="heading">Get running</h2>
            </div>
            <p className="lead">
              Pick your platform and the real installer downloads. A couple of
              first-run clicks and you are in a running window.
            </p>

            <InstallPanel version={version} />
          </div>
        </section>

        <section id="how" className="beats">
          <div className="wrap-wide">
            <div className="beats-head">
              <div className="section-head">
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

      </main>

      <SiteFooter version={version} />
    </>
  );
}
