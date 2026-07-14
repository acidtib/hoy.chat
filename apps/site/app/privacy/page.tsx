import type { Metadata } from "next";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { getLatestVersion } from "@/lib/releases";
import { REPO_URL, RELEASES_URL, canonical } from "@/lib/site";

export const metadata: Metadata = {
  title: "Privacy, Hoy Chat",
  description:
    "What Hoy sees, and does not see. The short version: your code, keys, and model calls never touch us.",
  // Override the layout's canonical so this page points at itself, not the home.
  alternates: { canonical: canonical("/privacy") },
};

// A short, honest policy. The local-first architecture does most of the work
// here, so this page is mostly a plain accounting of the few things that do
// reach a server, and whose server it is.
export default async function Privacy() {
  const version = await getLatestVersion();

  return (
    <>
      <SiteHeader version={version} />

      <main>
        <div className="wrap page-head">
          <h1>Privacy</h1>
          <p className="lead">
            The whole point of Hoy is that it runs on your machine. So this is a
            short page, because there is not much to tell. Last updated July 5,
            2026.
          </p>
        </div>

        <section className="legal">
          <div className="wrap">
            <p className="legal-tldr">
              Your code, your files, your prompts, and your API keys never touch
              our servers. There is no account to make and nothing to log in to.
              We do not run analytics, set cookies, or track you across the web.
            </p>

            <div className="legal-section">
              <h2>What never reaches Hoy</h2>
              <div className="legal-body">
                <p>
                  Hoy is a desktop app. Your repositories and API keys stay on
                  your own disk. Prompts and relevant code go directly to the
                  model provider you choose, never to Hoy. We have no way to see
                  them because there is no Hoy server in the loop.
                </p>
              </div>
            </div>

            <div className="legal-section">
              <h2>Where your prompts actually go</h2>
              <div className="legal-body">
                <p>
                  When you run a model, Hoy talks straight to whichever provider
                  that model belongs to, using your key, over your network
                  connection. Your prompts and the code you attach go to that
                  provider, for example Anthropic, OpenAI, Google, Groq, or an
                  endpoint you point it at yourself, under <em>their</em> privacy
                  terms, not ours. We are not a proxy and never see the traffic.
                  You pay the provider directly, so we never see the bill either.
                </p>
              </div>
            </div>

            <div className="legal-section">
              <h2>The few things that do reach a server</h2>
              <div className="legal-body">
                <ul>
                  <li>
                    <strong>Downloading Hoy.</strong> The installers are served
                    from{" "}
                    <a href={RELEASES_URL} target="_blank" rel="noreferrer">
                      GitHub Releases
                    </a>
                    , and this website is hosted on Cloudflare Pages. Both keep
                    standard access logs, which include your IP address and
                    browser user agent, the same as visiting any website. That is
                    GitHub and Cloudflare doing their normal hosting job, under
                    their privacy terms. We do not add our own analytics on top.
                  </li>
                  <li>
                    <strong>Checking for updates.</strong> The app periodically
                    asks GitHub whether a newer release exists, again through{" "}
                    <a href={RELEASES_URL} target="_blank" rel="noreferrer">
                      GitHub Releases
                    </a>
                    . That request goes to GitHub, subject to GitHub&apos;s
                    privacy terms, and comes back to your machine. It does not
                    pass through us, and we do not learn that you made it.
                  </li>
                  <li>
                    <strong>Arch package updates.</strong> If you installed from
                    the signed pacman repo, <code>pacman -Syu</code> fetches new
                    packages from <code>pkgs.hoy.chat</code>. Serving those files
                    leaves an access log with your IP, like any package mirror. We
                    use it only to serve the bytes, not to build a profile of you.
                  </li>
                </ul>
              </div>
            </div>

            <div className="legal-section">
              <h2>What we collect about you</h2>
              <div className="legal-body">
                <p>
                  Directly, essentially nothing. No account, no email, no usage
                  telemetry phoned home from the app. The only data that exists is
                  the incidental server access logs described above, held by our
                  hosting providers, which we do not mine, sell, or connect to any
                  identity.
                </p>
              </div>
            </div>

            <div className="legal-section">
              <h2>Cookies</h2>
              <div className="legal-body">
                <p>
                  This site does not set cookies or use tracking pixels. If your
                  browser stores anything, it is a local preference the page
                  itself needs, never an identifier we read.
                </p>
              </div>
            </div>

            <div className="legal-section">
              <h2>Your rights</h2>
              <div className="legal-body">
                <p>
                  Since we do not hold a profile on you, there is little for us to
                  show, correct, or delete. For the access logs held by GitHub and
                  Cloudflare, their own privacy policies and controls apply. If
                  you ever want to ask us something anyway, open an issue on{" "}
                  <a href={REPO_URL} target="_blank" rel="noreferrer">
                    GitHub
                  </a>
                  .
                </p>
              </div>
            </div>

            <div className="legal-section">
              <h2>Changes</h2>
              <div className="legal-body">
                <p>
                  Hoy is beta software and moving quickly. If we ever start
                  collecting anything new, this page changes first and the date at
                  the top moves with it.
                </p>
              </div>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter version={version} />
    </>
  );
}
