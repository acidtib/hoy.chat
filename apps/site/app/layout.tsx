import type { Metadata } from "next";
import Script from "next/script";
// Fontsource ships the Geist variable font as a local dependency, so the static
// build does not depend on fetching fonts from a network at build time. This is
// the same package the desktop app uses (@fontsource-variable/geist).
import "@fontsource-variable/geist";
import "./globals.css";
import { SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Hoy Chat, a desktop app for coding agents",
  description:
    "A real desktop app for your coding agent. It runs on your machine, uses your own API keys, and is powered by the Pi agent. Beta, expect rough edges.",
  metadataBase: new URL(SITE_URL),
  openGraph: {
    title: "Hoy Chat",
    description: "A desktop app for your coding agent. Runs locally, your keys. Beta.",
    url: SITE_URL,
    siteName: "Hoy Chat",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        {/* Set .js before paint so scroll-reveal pre-states apply only when JS
            can undo them; no-JS and headless renders stay fully visible. */}
        <Script id="js-flag" strategy="beforeInteractive">
          {`document.documentElement.classList.add('js')`}
        </Script>
        {children}
      </body>
    </html>
  );
}
