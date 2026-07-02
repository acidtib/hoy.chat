import Link from "next/link";
import Image from "next/image";
import appMock from "@/public/app-mock.png";
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
      "A desktop app for your coding agent. Runs on your machine, on your own keys.",
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
              <h1>Get your agent out of the terminal.</h1>
              <p className="tagline">
                Hoy gives it a real desktop app, so you can watch it work, keep
                every thread, and switch models on the fly, all on your machine,
                on your own keys.
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
            {/* On phones the two-pane window reflows into a cramped, clipped
                mess, so below the hero breakpoint we swap the live mock for a
                proportionally-correct capture of it. Regenerate this PNG from
                the desktop-rendered .appwin-hero if the mock changes. */}
            <Image
              className="hero-shot"
              src={appMock}
              alt="The Hoy desktop app: a sidebar of threads on the left, an open thread adding a health-check endpoint, an inline Edit diff on server.ts, and a composer at the bottom with the deepseek-v4 model selected."
              sizes="(max-width: 720px) 92vw, 940px"
            />
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
                No cloud account, no sign-up. Hoy drives the Pi agent under the
                hood, and your API key never leaves your disk. Nothing routes
                through a server we run.
              </p>
            </div>

            <div className="beat">
              <div className="beat-copy">
                <h3 className="heading">Close it. It&apos;s all still there.</h3>
                <p className="lead">
                  Quit Hoy, come back tomorrow, every thread exactly where you
                  left it. On your disk, not a server we run.
                </p>
              </div>
              <RevealOnScroll className="beat-visual">
                <SidebarBeat />
              </RevealOnScroll>
            </div>

            <div className="beat beat-reverse">
              <div className="beat-copy">
                <h3 className="heading">It shows its work.</h3>
                <p className="lead">
                  Every file it reads, every edit, every command lands in the
                  thread the moment it happens, result attached. No log
                  spelunking to find out what changed.
                </p>
              </div>
              <RevealOnScroll className="beat-visual">
                <ToolCallsBeat />
              </RevealOnScroll>
            </div>

            <div className="beat">
              <div className="beat-copy">
                <h3 className="heading">Your keys, your models.</h3>
                <p className="lead">
                  Drop in a key from Anthropic, OpenAI, DeepSeek, or Groq and
                  switch between them from one menu. Whatever your agent supports
                  shows up in the picker. No markup, no middleman.
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
