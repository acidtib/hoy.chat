import rootPackage from "../../../package.json";
import { RELEASES_API } from "./site";

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
// or GitHub rate limiting, resolves to an empty list. A GITHUB_TOKEN in the build
// env authenticates the request so shared runners are not rate-limited. CI later
// treats an empty result as fatal; local builds use the monorepo version.
let releasesPromise: Promise<Release[]> | undefined;

async function fetchReleases(): Promise<Release[]> {
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

// Share one release snapshot across every component rendered in this build.
export function getReleases(): Promise<Release[]> {
  releasesPromise ??= fetchReleases();
  return releasesPromise;
}

// Newest released version for page chrome and downloads. CI requires GitHub and
// the packaged version to agree so a deploy cannot publish stale asset links.
export async function getLatestVersion(): Promise<string> {
  const releases = await getReleases();
  const latest = releases[0]?.version;

  if (!latest) {
    if (process.env.CI) {
      throw new Error("Could not resolve the latest GitHub release during a CI build.");
    }
    return rootPackage.version;
  }

  if (process.env.CI && latest !== rootPackage.version) {
    throw new Error(
      `Latest GitHub release (${latest}) does not match the packaged version (${rootPackage.version}).`,
    );
  }

  return latest;
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
