import Link from "next/link";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { HeroStage } from "@/components/HeroStage";
import { RevealOnScroll } from "@/components/RevealOnScroll";
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
                The Pi coding agent lives in a terminal. Hoy gives it a window,
                so you can see what it is doing instead of squinting at
                scrollback.
              </p>

              <div className="cta-row cta-row-center">
                <HeroDownload version={version} />
                <Link className="btn btn-ghost" href="/changelog">
                  Changelog
                </Link>
              </div>
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
              Grab the build for your platform. Nothing is signed yet, so your OS
              will warn you the first time. Click through once and you are in.
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
                It all runs on your machine. Hoy talks to Pi as a separate local
                process, and your API key stays on your disk instead of passing
                through a server we run.
              </p>
            </div>

            <div className="beat">
              <div className="beat-copy">
                <h3 className="heading">Every session, kept</h3>
                <p className="lead">
                  Close Hoy, reopen it, and every thread is right where you left
                  it. Nothing syncs to a cloud, so nothing vanishes when some
                  service goes down.
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
                  When Pi reads a file, edits code, or runs a command, it lands in
                  the thread as it happens with the result attached. You never dig
                  through raw logs to work out what changed.
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
                  Paste in a key from Anthropic, OpenAI, DeepSeek, or Groq and
                  switch between them from one menu. If Pi can talk to it, Hoy
                  lists it.
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
