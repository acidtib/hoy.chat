import type { NextConfig } from "next";
import path from "node:path";

// Cloudflare Pages serves the site as plain static assets, so we pre-render
// everything to HTML at build time. There is no server runtime; downloads and
// the changelog data are resolved during the build, not at request time.
const nextConfig: NextConfig = {
  output: "export",
  // Static export cannot run the Next image optimizer (it needs a server), so
  // images must pass through unoptimized.
  images: { unoptimized: true },
  turbopack: {
    // Pin the workspace root to the monorepo root so Next does not guess when
    // several lockfiles are present (e.g. inside a git worktree); deps are
    // hoisted there by the Bun workspace.
    root: path.resolve(import.meta.dirname, "../.."),
  },
};

export default nextConfig;
