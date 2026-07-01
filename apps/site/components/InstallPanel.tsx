"use client";

import { useEffect, useState } from "react";
import { RELEASES_LATEST_URL, RELEASES_URL } from "@/lib/site";

type OS = "macos" | "windows" | "linux";

const LABEL: Record<OS, string> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
};
const OSES: OS[] = ["macos", "windows", "linux"];

function detectOS(): OS | null {
  if (typeof navigator === "undefined") return null;
  const s = `${navigator.userAgent} ${navigator.platform ?? ""}`.toLowerCase();
  if (s.includes("mac")) return "macos";
  if (s.includes("win")) return "windows";
  if (s.includes("linux") || s.includes("x11")) return "linux";
  return null;
}

function OSIcon({ os }: { os: OS }) {
  if (os === "macos") {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.53 4.09l.01-.01M12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
      </svg>
    );
  }
  if (os === "windows") {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M3 5.6 10.4 4.6v6.7H3zM11.4 4.5 21 3.2v8.1h-9.6zM3 12.7h7.4v6.7L3 18.4zM11.4 12.7H21v8.1l-9.6-1.3z" />
      </svg>
    );
  }
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l3 3-3 3M13 15h4" />
    </svg>
  );
}

type Step = { text: string; cmd?: string };
const CONTENT: Record<OS, { artifacts: string; steps: Step[]; note: string }> = {
  macos: {
    artifacts: "Universal .dmg, Apple Silicon and Intel",
    steps: [
      { text: "Download the .dmg and drag Hoy to Applications." },
      { text: "First launch: right-click the app and choose Open." },
      {
        text: "Or clear the quarantine flag from a terminal:",
        cmd: "xattr -dr com.apple.quarantine /Applications/Hoy.app",
      },
    ],
    note: "Unsigned build, Gatekeeper warns on first open. Code signing is a known pre-1.0 gap.",
  },
  windows: {
    artifacts: ".msi installer or portable .exe",
    steps: [
      { text: "Download the installer and run it." },
      { text: "SmartScreen warns: choose More info, then Run anyway." },
    ],
    note: "Unsigned build, SmartScreen and some antivirus tools will flag it.",
  },
  linux: {
    artifacts: ".AppImage or .deb, x86_64",
    steps: [
      {
        text: "AppImage: make it executable, then run it.",
        cmd: "chmod +x Hoy_*.AppImage && ./Hoy_*.AppImage",
      },
      { text: "Debian/Ubuntu: install the .deb.", cmd: "sudo dpkg -i hoy_*.deb" },
    ],
    note: "No apt/rpm repo yet, grab the file straight from Releases.",
  },
};

function Cmd({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="cmd">
      <code>{text}</code>
      <button
        type="button"
        className="cmd-copy"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            /* clipboard unavailable */
          }
        }}
        aria-label="Copy command"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function InstallPanel({ version }: { version: string }) {
  const [os, setOs] = useState<OS>("macos");
  const [detected, setDetected] = useState<OS | null>(null);

  useEffect(() => {
    const d = detectOS();
    if (d) {
      setDetected(d);
      setOs(d);
    }
  }, []);

  const primaryLabel = detected
    ? `Download for ${LABEL[detected]}`
    : `Download v${version}`;
  const others = OSES.filter((o) => o !== detected).map((o) => LABEL[o]);
  const c = CONTENT[os];

  return (
    <div className="install">
      <div className="install-top">
        <a className="btn btn-primary btn-lg" href={RELEASES_LATEST_URL}>
          {primaryLabel}
        </a>
        <p className="install-meta">
          Free, bring your own API key.
          {detected && (
            <span className="install-others"> Also on {others.join(" and ")}.</span>
          )}
        </p>
      </div>

      <div className="install-panel">
        <div className="seg" role="tablist" aria-label="Platform">
          {OSES.map((o) => (
            <button
              key={o}
              type="button"
              role="tab"
              aria-selected={o === os}
              className={o === os ? "seg-btn seg-btn-active" : "seg-btn"}
              onClick={() => setOs(o)}
            >
              <OSIcon os={o} />
              {LABEL[o]}
            </button>
          ))}
        </div>

        <div className="install-body">
          <p className="install-artifacts">
            {c.artifacts} {"·"}{" "}
            <a href={RELEASES_LATEST_URL}>v{version}</a>
          </p>
          <ol className="install-steps">
            {c.steps.map((s, i) => (
              <li key={i}>
                {s.text}
                {s.cmd && <Cmd text={s.cmd} />}
              </li>
            ))}
          </ol>
          <p className="install-note">
            {c.note} <a href={RELEASES_URL}>All releases</a>
          </p>
        </div>
      </div>
    </div>
  );
}
