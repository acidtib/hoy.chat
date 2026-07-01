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

// Small OS-aware nudge under the hero CTA. Progressive enhancement: the
// server-rendered default lists all three platforms, so it reads fine with JS
// disabled. The detailed per-OS download lives in the InstallPanel below.
export function PlatformPicker() {
  const [os, setOs] = useState<OS | null>(null);

  useEffect(() => {
    setOs(detectOS());
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
