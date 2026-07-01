import Link from "next/link";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { getLatestVersion } from "@/lib/releases";
import { RELEASES_URL, RELEASES_LATEST_URL } from "@/lib/site";

// Resolved at build time via the static export; a new GitHub release refreshes
// the displayed version on the next deploy without editing this file.
export default async function Home() {
  const version = await getLatestVersion();

  return (
    <>
      <SiteHeader />

      <main>
        {/* 1. Hey, look at this thing. */}
        <section className="hero">
          <div className="wrap">
            <span className="badge">
              <span className="pulse" aria-hidden="true" />
              Beta / Experimental
            </span>
            <h1>Hoy</h1>
            <p className="tagline">A native desktop GUI for the Pi coding agent.</p>

            <p className="beta-note">
              <strong>This is experimental, pre-1.0 software.</strong> Expect bugs
              and breaking changes between builds. You bring your own API key, and
              nothing here is meant for production use. If that sounds fine, grab a
              build below.
            </p>

            <div className="cta-row">
              <a className="btn btn-primary" href={RELEASES_LATEST_URL}>
                Download v{version}
              </a>
              <Link className="btn btn-ghost" href="/changelog">
                Changelog
              </Link>
            </div>
          </div>
        </section>

        {/* 2. How to install it. */}
        <section id="install">
          <div className="wrap">
            <p className="section-title">Install</p>
            <h2 className="heading">Get running</h2>
            <p className="lead">
              Grab the latest build from GitHub Releases, then follow the steps for
              your platform. Current build is v{version}.
            </p>

            <div className="grid">
              <div className="card">
                <span className="platform-tag">Platform</span>
                <h3>macOS</h3>
                <ol>
                  <li>
                    Download the <code>.dmg</code> from{" "}
                    <a href={RELEASES_LATEST_URL}>Releases</a>.
                  </li>
                  <li>Open it and drag Hoy to Applications.</li>
                  <li>
                    First launch: right-click the app and choose Open to bypass
                    Gatekeeper on an unsigned build.
                  </li>
                </ol>
              </div>

              <div className="card">
                <span className="platform-tag">Platform</span>
                <h3>Linux</h3>
                <ol>
                  <li>
                    Download the <code>.AppImage</code> or <code>.deb</code> from{" "}
                    <a href={RELEASES_LATEST_URL}>Releases</a>.
                  </li>
                  <li>
                    AppImage: <code>chmod +x</code> it, then run it.
                  </li>
                  <li>
                    Debian/Ubuntu: install with{" "}
                    <code>sudo dpkg -i hoy_*.deb</code>.
                  </li>
                </ol>
              </div>

              <div className="card">
                <span className="platform-tag">Platform</span>
                <h3>Windows</h3>
                <ol>
                  <li>
                    Download the <code>.msi</code> or <code>.exe</code> from{" "}
                    <a href={RELEASES_LATEST_URL}>Releases</a>.
                  </li>
                  <li>Run the installer.</li>
                  <li>
                    SmartScreen will warn: choose More info, then Run anyway (see
                    note below).
                  </li>
                </ol>
              </div>
            </div>

            <p className="callout">
              <strong>Heads up:</strong> Windows builds are currently unsigned, so
              SmartScreen and some antivirus tools will flag the installer. Code
              signing is a known pre-1.0 gap. On macOS, unsigned builds need the
              right-click, Open step on first launch.
            </p>

            <div className="cta-row" style={{ justifyContent: "flex-start" }}>
              <a className="btn btn-ghost" href={RELEASES_URL}>
                All releases
              </a>
            </div>
          </div>
        </section>

        {/* 3. How it works / what it looks like. */}
        <section id="how">
          <div className="wrap">
            <p className="section-title">How it works</p>
            <h2 className="heading">Local, and yours</h2>
            <p className="lead">
              Hoy runs on your machine and talks to the Pi coding agent as a
              separate local process. You bring your own API key; it is stored
              locally and never leaves your machine through Hoy.
            </p>

            {/* TODO(HOY-224): replace these placeholders with real app
                screenshots once release captures exist (sidebar, streaming
                thread, tool calls rendering). Keep alt text descriptive. */}
            <div className="shots">
              <div className="shot" role="img" aria-label="Placeholder: Hoy session sidebar listing conversations">
                Screenshot placeholder: session sidebar
              </div>
              <div className="shot" role="img" aria-label="Placeholder: a streaming conversation thread in Hoy">
                Screenshot placeholder: streaming thread
              </div>
              <div className="shot" role="img" aria-label="Placeholder: tool calls rendering inline in a Hoy thread">
                Screenshot placeholder: tool calls rendering
              </div>
              <div className="shot" role="img" aria-label="Placeholder: model selector and settings in Hoy">
                Screenshot placeholder: model selector
              </div>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter version={version} />
    </>
  );
}
