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
  TreeBeat,
  FleetBeat,
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
      <SiteHeader version={version} />

      <main>
        <section className="hero">
          <div className="hero-bg" aria-hidden="true" />
          <div className="wrap-wide">
            <div className="hero-lead">
              <span className="badge">
                <span className="pulse" aria-hidden="true" />
                Beta / bugs included
              </span>
              <h1>Local. Fast. Yours.</h1>
              <p className="tagline">
                A desktop agent harness you can see and steer. Runs locally, uses
                your own model keys, and is built on Pi under the hood.
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
              alt="The Hoy desktop app, a sidebar of threads on the left each marked with its model's provider icon, an open thread adding a health-check endpoint, an inline Edit diff on server.ts, a composer at the bottom with the DeepSeek V4 Flash model selected, and the Tree navigator open on the right."
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
              Grab the build for your platform. We haven&apos;t bought a
              code signing certificate yet, so macOS and Windows will raise an
              eyebrow the first time. On Arch,
              the pacman repo is signed end to end, so no eyebrows at all.
            </p>

            <InstallPanel version={version} />
          </div>
        </section>

        <section id="how" className="beats">
          <div className="wrap-wide">
            <div className="beats-head">
              <div className="section-head">
                <h2 className="heading">See everything. Route nothing through us.</h2>
              </div>
              <p className="lead">
                Hoy runs locally and connects directly to the model providers you
                choose. Your code and prompts never pass through Hoy servers.
                Branch any turn into a new direction, or hand a goal to a whole
                team of agents at once.
              </p>
            </div>

            <div className="beat">
              <div className="beat-copy">
                <h3 className="heading">Close it. It&apos;s all still there.</h3>
                <p className="lead">
                  Quit Hoy, come back next week, and every thread is right where
                  you left it, saved to your disk like any other file. Pick up
                  mid thought and keep going.
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
                  Every file it reads, every edit, every command shows up in the
                  thread the moment it happens, result attached. No log spelunking
                  to work out what your agent actually did.
                </p>
              </div>
              <RevealOnScroll className="beat-visual">
                <ToolCallsBeat />
              </RevealOnScroll>
            </div>

            <div className="beat">
              <div className="beat-copy">
                <h3 className="heading">Changed your mind? Branch it.</h3>
                <p className="lead">
                  Every turn is a fork in the road. Open the tree, grab any point,
                  and start a fresh line from there while the original sits
                  untouched. Chase the risky idea, your good thread will be waiting
                  when you get back.
                </p>
              </div>
              <RevealOnScroll className="beat-visual">
                <TreeBeat />
              </RevealOnScroll>
            </div>

            <div className="beat beat-reverse">
              <div className="beat-copy">
                <h3 className="heading">One agent, or a whole team.</h3>
                <p className="lead">
                  Hand off a plan and Hoy splits it across agents working in
                  parallel, one exploring, one editing, one testing, with FleetView
                  keeping the whole crew in a single view. Steer every step, or pour
                  a coffee and let them run.
                </p>
              </div>
              <RevealOnScroll className="beat-visual">
                <FleetBeat />
              </RevealOnScroll>
            </div>

            <div className="beat">
              <div className="beat-copy">
                <h3 className="heading">Your keys, your models.</h3>
                <p className="lead">
                  Bring a key for whichever provider you like, Anthropic, OpenAI,
                  Google, Groq, xAI, OpenRouter, Ollama and beyond, then switch
                  between them mid conversation without dropping the thread. You pay
                  the provider directly, we never see the bill.
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
