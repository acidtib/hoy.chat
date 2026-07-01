import type { Metadata } from "next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { getReleases, getLatestVersion, formatDate } from "@/lib/releases";
import { RELEASES_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Changelog, Hoy",
  description: "Released versions of Hoy Desktop, sourced from GitHub Releases.",
};

// Built statically from GitHub Releases. getReleases() swallows any fetch
// failure and returns an empty list, so an empty or errored fetch renders the
// empty state below rather than breaking the static export.
export default async function Changelog() {
  const releases = await getReleases();
  const version = await getLatestVersion();

  return (
    <>
      <SiteHeader />

      <main>
        <div className="wrap page-head">
          <h1>Changelog</h1>
          <p className="lead">
            Released builds of Hoy, pulled from{" "}
            <a href={RELEASES_URL} target="_blank" rel="noreferrer">
              GitHub Releases
            </a>
            . Newest first.
          </p>
        </div>

        <section style={{ paddingTop: 8 }}>
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
              releases.map((r) => (
                <article key={r.version} className="changelog-entry">
                  <div className="changelog-head">
                    <h2>{r.name || r.version}</h2>
                    {r.prerelease && <span className="tag-pre">Pre-release</span>}
                    {r.date && (
                      <span className="changelog-date">{formatDate(r.date)}</span>
                    )}
                  </div>
                  {r.notes ? (
                    <div className="markdown">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {r.notes}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <p className="markdown">No notes for this release.</p>
                  )}
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
