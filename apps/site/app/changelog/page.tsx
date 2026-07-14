import type { Metadata } from "next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { getReleases, getLatestVersion, formatDate } from "@/lib/releases";
import { RELEASES_URL, canonical } from "@/lib/site";

export const metadata: Metadata = {
  title: "Changelog, Hoy Chat",
  description: "Every build of Hoy we have shipped, pulled from GitHub Releases.",
  // Override the layout's canonical so this page points at itself, not the home.
  alternates: { canonical: canonical("/changelog") },
};

// Built statically from GitHub Releases. getReleases() swallows any fetch
// failure and returns an empty list, so an empty or errored fetch renders the
// empty state below rather than breaking the static export.
export default async function Changelog() {
  const releases = await getReleases();
  const version = releases[0]?.version ?? (await getLatestVersion());

  return (
    <>
      <SiteHeader version={version} />

      <main>
        <div className="wrap page-head">
          <h1>Changelog</h1>
          <p className="lead">
            Every build we have shipped, straight from{" "}
            <a href={RELEASES_URL} target="_blank" rel="noreferrer">
              GitHub Releases
            </a>
            . Newest first.
          </p>
        </div>

        <section className="changelog-list">
          <div className="wrap">
            {releases.length === 0 ? (
              <div className="empty-state">
                No releases to show yet. Check{" "}
                <a href={RELEASES_URL} target="_blank" rel="noreferrer">
                  GitHub Releases
                </a>{" "}
                for the latest builds.
              </div>
            ) : (
              releases.map((r, i) => (
                <article key={r.version} id={r.version} className="changelog-entry">
                  <div className="changelog-rail">
                    <div className="changelog-meta">
                      <h2>
                        <a className="changelog-anchor" href={`#${r.version}`}>
                          {r.name || r.version}
                        </a>
                      </h2>
                      {(i === 0 || r.prerelease) && (
                        <div className="changelog-tags">
                          {i === 0 && <span className="tag-latest">Latest</span>}
                          {r.prerelease && (
                            <span className="tag-pre">Pre-release</span>
                          )}
                        </div>
                      )}
                      {r.date && (
                        <span className="changelog-date">{formatDate(r.date)}</span>
                      )}
                      {r.url && (
                        <a
                          className="changelog-source"
                          href={r.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          View on GitHub
                        </a>
                      )}
                    </div>
                  </div>
                  <div className="changelog-body">
                    {r.notes ? (
                      <div className="markdown">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {r.notes}
                        </ReactMarkdown>
                      </div>
                    ) : (
                      <p className="markdown">No notes for this release.</p>
                    )}
                  </div>
                </article>
              ))
            )}
          </div>
        </section>
      </main>

      <SiteFooter version={version} />
    </>
  );
}
