"use client";

import { assetUrl, OS_DOWNLOADS } from "@/lib/downloads";
import { useDetectedOS } from "@/lib/platform";

// Hero primary CTA. Server-renders a stable direct download (macOS default) so
// there is a real file link with JS off, then swaps to the visitor's detected OS.
export function HeroDownload({ version }: { version: string }) {
  const os = useDetectedOS();

  const target = OS_DOWNLOADS[os ?? "macos"];
  const asset = target.assets[0];

  return (
    <a
      className="btn btn-primary"
      href={assetUrl(version, asset.file(version))}
    >
      Download {os ? `for ${target.name} · v${version}` : `v${version}`}
    </a>
  );
}
