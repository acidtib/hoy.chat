import type { Metadata } from "next";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { getLatestVersion } from "@/lib/releases";
import { REPO_URL, LICENSE, canonical } from "@/lib/site";

export const metadata: Metadata = {
  title: "Terms, Hoy Chat",
  description:
    "The plain-language deal for using Hoy: free, MIT licensed, beta, and provided as-is. Bring your own keys.",
  // Override the layout's canonical so this page points at itself, not the home.
  alternates: { canonical: canonical("/terms") },
};

// A short EULA in the site's voice. The load-bearing parts are the warranty
// disclaimer and liability cap: Hoy runs commands and edits files on the user's
// machine, so "as-is, back up your work, you own what you run" needs saying
// plainly and on the record.
export default async function Terms() {
  const version = await getLatestVersion();

  return (
    <>
      <SiteHeader version={version} />

      <main>
        <div className="wrap page-head">
          <h1>Terms</h1>
          <p className="lead">
            The deal for using Hoy, in plain language. Last updated July 5, 2026.
          </p>
        </div>

        <section className="legal">
          <div className="wrap">
            <p className="legal-tldr">
              Hoy is free, {LICENSE} licensed, and still in beta. You bring your
              own API keys. It is provided as-is, with no warranty, and you are
              responsible for what you point it at. Back up your work.
            </p>

            <div className="legal-section">
              <h2>The license</h2>
              <div className="legal-body">
                <p>
                  Hoy is open source under the {LICENSE} License. That license is
                  the real legal grant, and it governs your right to use, copy,
                  and modify the software. You can read the full text on{" "}
                  <a
                    href={`${REPO_URL}/blob/main/LICENSE`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    GitHub
                  </a>
                  . Where anything on this page and the {LICENSE} License
                  disagree, the license wins.
                </p>
              </div>
            </div>

            <div className="legal-section">
              <h2>It is beta, and it does real things</h2>
              <div className="legal-body">
                <p>
                  Hoy drives a coding agent that reads your files, edits them, and
                  runs commands on your machine. That is the entire point, and it
                  also means a bad prompt or an overeager agent can change or
                  delete work. Use version control, keep backups, and read what it
                  proposes before you let it run wide. You decide what Hoy has
                  access to and what it is allowed to do.
                </p>
              </div>
            </div>

            <div className="legal-section">
              <h2>No warranty</h2>
              <div className="legal-body">
                <p>
                  Hoy is provided &quot;as-is&quot; and &quot;as available,&quot;
                  without warranty of any kind, express or implied, including
                  merchantability, fitness for a particular purpose, and
                  non-infringement. Beta means bugs included. We do not promise it
                  is correct, uninterrupted, or safe for any particular use.
                </p>
              </div>
            </div>

            <div className="legal-section">
              <h2>Limitation of liability</h2>
              <div className="legal-body">
                <p>
                  To the fullest extent the law allows, we are not liable for any
                  damages arising from your use of Hoy, including lost data, lost
                  work, lost profits, or damaged code, whether the claim is in
                  contract, tort, or anything else. Hoy is free software, and this
                  cap is part of the deal for it being free.
                </p>
              </div>
            </div>

            <div className="legal-section">
              <h2>Your keys and your provider bills</h2>
              <div className="legal-body">
                <p>
                  Hoy uses the API keys you supply, and your model calls go
                  directly to those providers. You are bound by each
                  provider&apos;s own terms, and you pay them directly for what
                  you use. We never see the bill and are not part of that
                  transaction.
                </p>
              </div>
            </div>

            <div className="legal-section">
              <h2>Acceptable use</h2>
              <div className="legal-body">
                <p>
                  Do not use Hoy to break the law, to build things designed to
                  harm others, or to violate the terms of the model providers it
                  connects to. Beyond that, it is your tool. Use it well.
                </p>
              </div>
            </div>

            <div className="legal-section">
              <h2>Changes</h2>
              <div className="legal-body">
                <p>
                  These terms can change as Hoy grows up. When they do, this page
                  changes and the date at the top moves with it. Continuing to use
                  Hoy after a change means you accept it. If you have a question,
                  open an issue on{" "}
                  <a href={REPO_URL} target="_blank" rel="noreferrer">
                    GitHub
                  </a>
                  .
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
