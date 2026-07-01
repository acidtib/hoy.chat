"use client";

import { useEffect, useState } from "react";
import { assetUrl, OS_DOWNLOADS, type OS } from "@/lib/downloads";

function detectOS(): OS | null {
  if (typeof navigator === "undefined") return null;
  const s = `${navigator.userAgent} ${navigator.platform ?? ""}`.toLowerCase();
  if (s.includes("mac")) return "macos";
  if (s.includes("win")) return "windows";
  if (s.includes("linux") || s.includes("x11")) return "linux";
  return null;
}

// Hero primary CTA. Server-renders a stable direct download (macOS default) so
// there is a real file link with JS off, then swaps to the visitor's detected OS.
export function HeroDownload({ version }: { version: string }) {
  const [os, setOs] = useState<OS | null>(null);

  useEffect(() => {
    setOs(detectOS());
  }, []);

  const target = OS_DOWNLOADS[os ?? "macos"];
  const asset = target.assets[0];

  return (
    <a
      className="btn btn-primary"
      href={assetUrl(version, asset.file(version))}
    >
      Download {os ? `for ${target.name}` : `v${version}`}
    </a>
  );
}
