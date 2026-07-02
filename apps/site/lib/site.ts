// Single source of truth for repo and release links. The install/download
// links point at the GitHub Releases page rather than hardcoded asset URLs so a
// new build shows up without editing markup; FALLBACK_VERSION is only used when
// the build-time releases fetch is empty or fails.

// The site's own canonical origin, used for metadataBase and OpenGraph URLs.
// Defaults to the production apex; a beta or preview deploy sets
// NEXT_PUBLIC_SITE_URL to its own origin (e.g. the Pages custom domain) so the
// metadata advertises where the page actually lives instead of pointing
// crawlers at production. Inlined at build time (static export).
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://hoy.chat";

export const REPO = "acidtib/hoy.chat";
export const REPO_URL = `https://github.com/${REPO}`;
export const RELEASES_URL = `${REPO_URL}/releases`;
export const RELEASES_LATEST_URL = `${RELEASES_URL}/latest`;
export const RELEASES_API = `https://api.github.com/repos/${REPO}/releases`;

// Shown only when GitHub returns nothing at build time. Keep in sync with the
// desktop app's current build.
export const FALLBACK_VERSION = "0.1.1";

export const LICENSE = "MIT";
