import { RELEASES_API, FALLBACK_VERSION } from "./site";

export interface Release {
  version: string;
  name: string;
  date: string;
  notes: string;
  url: string;
  prerelease: boolean;
}

interface GitHubRelease {
  tag_name?: string;
  name?: string | null;
  body?: string | null;
  html_url?: string;
  published_at?: string | null;
  created_at?: string | null;
  draft?: boolean;
  prerelease?: boolean;
}

// Drop a leading "v" so tags like "v0.1.1" render as "0.1.1".
export function normalizeVersion(tag: string): string {
  return tag.replace(/^v/i, "");
}

// Fetched once at build time (static export). Any failure, including no network
// or GitHub rate limiting, resolves to an empty list so the build never breaks;
// callers render an empty state instead. A GITHUB_TOKEN in the build env (CI)
// authenticates the request so shared runners are not rate-limited; local builds
// run unauthenticated and fall back to FALLBACK_VERSION if throttled.
export async function getReleases(): Promise<Release[]> {
  try {
    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    const res = await fetch(RELEASES_API, {
      headers: {
        Accept: "application/vnd.github+json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!res.ok) return [];
    const data: unknown = await res.json();
    if (!Array.isArray(data)) return [];

    return (data as GitHubRelease[])
      .filter((r) => !r.draft)
      .map((r) => ({
        version: normalizeVersion(r.tag_name ?? r.name ?? ""),
        name: r.name ?? r.tag_name ?? "",
        date: r.published_at ?? r.created_at ?? "",
        notes: r.body?.trim() ?? "",
        url: r.html_url ?? "",
        prerelease: Boolean(r.prerelease),
      }))
      .filter((r) => r.version.length > 0);
  } catch {
    return [];
  }
}

// Newest released version for the install section and footer; falls back to the
// pinned build when releases cannot be fetched.
export async function getLatestVersion(): Promise<string> {
  const releases = await getReleases();
  return releases[0]?.version ?? FALLBACK_VERSION;
}

export function formatDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}
