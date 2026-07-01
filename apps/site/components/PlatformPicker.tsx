"use client";

import { useEffect, useState } from "react";

type OS = "macos" | "windows" | "linux";

const LABEL: Record<OS, string> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
};

function detectOS(): OS | null {
  if (typeof navigator === "undefined") return null;
  const s = `${navigator.userAgent} ${navigator.platform ?? ""}`.toLowerCase();
  if (s.includes("mac")) return "macos";
  if (s.includes("win")) return "windows";
  if (s.includes("linux") || s.includes("x11")) return "linux";
  return null;
}

// Renders the honest download hint (assets live on the Releases page) and, when
// the visitor's OS is recognizable, flags the matching install card. Progressive
// enhancement: the server-rendered default lists all three platforms, so the
// hint is meaningful with JS disabled.
export function PlatformPicker() {
  const [os, setOs] = useState<OS | null>(null);

  useEffect(() => {
    const detected = detectOS();
    setOs(detected);
    if (detected) {
      document
        .getElementById(`dl-${detected}`)
        ?.setAttribute("data-recommended", "true");
    }
  }, []);

  return (
    <p className="cta-hint">
      {os ? (
        <>
          Detected <span className="os">{LABEL[os]}</span>. Grab your build, or
          pick another on the Releases page.
        </>
      ) : (
        <>
          Builds for <span className="os">macOS</span>,{" "}
          <span className="os">Linux</span>, and{" "}
          <span className="os">Windows</span> on the Releases page.
        </>
      )}
    </p>
  );
}
