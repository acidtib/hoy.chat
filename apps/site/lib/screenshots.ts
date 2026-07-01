import fs from "node:fs";
import path from "node:path";

// Ordered manifest of product screenshots for the "See it work" section. A shot
// renders ONLY when its file exists under public/ at build time, so the section
// never ships placeholder or broken images: drop the PNGs in (names below) and
// they appear on the next build. Until then the section shows explainer copy and
// the coded streaming preview carries the visual weight.
export interface Shot {
  src: string;
  alt: string;
  caption: string;
}

const MANIFEST: Shot[] = [
  {
    src: "/screenshots/sidebar.png",
    alt: "Hoy's session sidebar listing several coding conversations grouped by project.",
    caption: "Sessions and projects in the sidebar",
  },
  {
    src: "/screenshots/streaming.png",
    alt: "A Hoy conversation thread streaming an assistant reply token by token.",
    caption: "Streaming, token by token",
  },
  {
    src: "/screenshots/tool-calls.png",
    alt: "Tool calls rendered inline in a Hoy thread, showing file edits and command output.",
    caption: "Tool calls rendered inline",
  },
  {
    src: "/screenshots/model-selector.png",
    alt: "Hoy's model selector open, listing available models across providers.",
    caption: "Pick any model you have a key for",
  },
];

export function availableShots(): Shot[] {
  const publicDir = path.join(process.cwd(), "public");
  return MANIFEST.filter((shot) => {
    try {
      return fs.existsSync(path.join(publicDir, shot.src));
    } catch {
      return false;
    }
  });
}
