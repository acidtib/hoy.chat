import type { MetadataRoute } from "next";

// Generated as a static web app manifest at build time (output: export).
// Icons reference public/brand/*, copied from the hoy.chat brand kit.
export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Hoy Chat",
    short_name: "Hoy Chat",
    description: "A desktop app for your coding agent. Runs locally, your keys.",
    start_url: "/",
    display: "standalone",
    background_color: "#0e0e10",
    theme_color: "#0e0e10",
    icons: [
      { src: "/brand/android-chrome-192x192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/brand/android-chrome-512x512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/brand/masking-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
