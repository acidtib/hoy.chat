"use client";

import { useEffect, useState } from "react";
import {
  assetUrl,
  OS_DOWNLOADS,
  OS_ORDER,
  RELEASES_LIST_URL,
  type OS,
} from "@/lib/downloads";

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
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2c-1.5 0-2.6 1.3-2.6 3 0 .8.1 1.6.1 2.4-.5.7-1.3 1.5-2 2.6-.8 1.2-1.4 2.7-1.4 4.4 0 .4-.3.7-.7 1.2-.4.4-.9.9-.9 1.6 0 .3.1.6.4.7.2.1.5.2.8.3.6.2 1.2.4 1.6.9.5.6 1.3 1.2 2.9 1.2h1.6c1.6 0 2.4-.6 2.9-1.2.4-.5 1-.7 1.6-.9.3-.1.6-.2.8-.3.3-.1.4-.4.4-.7 0-.7-.5-1.2-.9-1.6-.4-.5-.7-.8-.7-1.2 0-1.7-.6-3.2-1.4-4.4-.7-1.1-1.5-1.9-2-2.6 0-.8.1-1.6.1-2.4 0-1.7-1.1-3-2.6-3zm-1 4.6c.3 0 .5.3.5.7s-.2.7-.5.7-.5-.3-.5-.7.2-.7.5-.7zm2 0c.3 0 .5.3.5.7s-.2.7-.5.7-.5-.3-.5-.7.2-.7.5-.7z" />
    </svg>
  );
}

export function InstallPanel({ version }: { version: string }) {
  const [detected, setDetected] = useState<OS | null>(null);

  useEffect(() => {
    setDetected(detectOS());
  }, []);

  const primaryOS = detected ?? "macos";
  const primary = OS_DOWNLOADS[primaryOS];
  const primaryAsset = primary.assets[0];

  return (
    <div className="dl">
      <div className="dl-hero">
        <a
          className="btn btn-primary btn-lg"
          href={assetUrl(version, primaryAsset.file(version))}
        >
          Download for {primary.name}
        </a>
        <p className="dl-caption">
          {primaryAsset.label}
          {" · "}v{version}
          {" · "}free, bring your own API key
        </p>
      </div>

      <div className="dl-grid">
        {OS_ORDER.map((os) => {
          const d = OS_DOWNLOADS[os];
          return (
            <div
              key={os}
              className={os === detected ? "dl-os dl-os-active" : "dl-os"}
            >
              <span className="dl-os-name">
                <OSIcon os={os} />
                {d.name}
                {os === detected && <span className="dl-tag">Detected</span>}
              </span>
              <span className="dl-os-links">
                {d.assets.map((a, i) => (
                  <span key={a.label}>
                    {i > 0 && <span className="dl-sep">/</span>}
                    <a href={assetUrl(version, a.file(version))}>{a.label}</a>
                  </span>
                ))}
              </span>
              <span className="dl-os-note">{d.note}</span>
            </div>
          );
        })}
      </div>

      <p className="dl-foot">
        Nothing is signed until 1.0, so every OS shows a first-run warning.{" "}
        <a href={RELEASES_LIST_URL} target="_blank" rel="noreferrer">
          All releases and checksums
        </a>
      </p>
    </div>
  );
}
