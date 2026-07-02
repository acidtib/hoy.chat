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
import { PRODUCTION_URL, RELEASES_URL } from "@/lib/site";

// Resolved at build time via the static export; a new GitHub release refreshes
// the displayed version on the next deploy without editing this file.
export default async function Home() {
  const version = await getLatestVersion();

  const softwareJsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Hoy Chat",
    applicationCategory: "DeveloperApplication",
    operatingSystem: "macOS, Windows, Linux",
    softwareVersion: version,
    url: PRODUCTION_URL,
    downloadUrl: RELEASES_URL,
    description:
      "A desktop app for your coding agent. It runs on your machine, uses your own API keys, and is powered by the Pi agent.",
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareJsonLd) }}
      />
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
              <h1>Simple. Fast. Yours.</h1>
              <p className="tagline">
                Hoy gives your coding agent a real window, so you can
                watch it work, keep every thread, and switch models without ever
                opening a terminal.
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
              Grab the build for your platform. The direct downloads aren&apos;t
              signed yet, so your OS warns you the first time; click through once
              and you are in. On Arch, the pacman repo is signed end to end.
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
                Everything runs on your machine. Under the hood Hoy drives the Pi
                agent as a separate local process, and your API key stays on your
                disk instead of passing through a server we run.
              </p>
            </div>

            <div className="beat">
              <div className="beat-copy">
                <h3 className="heading">Never lose a thread</h3>
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
                <h3 className="heading">Watch every move</h3>
                <p className="lead">
                  When the agent reads a file, edits code, or runs a command, it
                  lands in the thread as it happens with the result attached. You
                  never dig through raw logs to work out what changed.
                </p>
              </div>
              <RevealOnScroll className="beat-visual">
                <ToolCallsBeat />
              </RevealOnScroll>
            </div>

            <div className="beat">
              <div className="beat-copy">
                <h3 className="heading">Bring any model</h3>
                <p className="lead">
                  Paste in a key from Anthropic, OpenAI, DeepSeek, or Groq and
                  switch between them from one menu. Every model your agent
                  supports shows up in the picker.
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
