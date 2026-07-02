import type { Metadata, Viewport } from "next";
import Script from "next/script";
// Fontsource ships the Geist variable font as a local dependency, so the static
// build does not depend on fetching fonts from a network at build time. This is
// the same package the desktop app uses (@fontsource-variable/geist).
import "@fontsource-variable/geist";
import "./globals.css";
import { SITE_URL, IS_PRODUCTION, canonical, PRODUCTION_URL } from "@/lib/site";

const DESCRIPTION =
  "A real desktop app for your coding agent. It runs on your machine and uses your own API keys. Beta, expect rough edges.";

export const metadata: Metadata = {
  title: "Hoy Chat, a desktop app for coding agents",
  description: DESCRIPTION,
  metadataBase: new URL(SITE_URL),
  applicationName: "Hoy Chat",
  keywords: [
    "coding agent",
    "desktop app for coding agents",
    "AI coding agent GUI",
    "local coding agent",
    "bring your own API key",
  ],
  // Every deploy consolidates to the production apex; the beta stays out of the
  // index entirely until it becomes that apex.
  alternates: { canonical: canonical("/") },
  robots: IS_PRODUCTION ? undefined : { index: false, follow: false },
  openGraph: {
    title: "Hoy Chat, a desktop app for coding agents",
    description: "A desktop app for your coding agent. Runs locally, your keys. Beta.",
    url: SITE_URL,
    siteName: "Hoy Chat",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Hoy Chat, a desktop app for coding agents",
    description: "A desktop app for your coding agent. Runs locally, your keys. Beta.",
  },
};

export const viewport: Viewport = {
  themeColor: "#0e0e10",
};

// Consolidated to the production apex so the identity is stable across the beta
// and production deploys.
const WEBSITE_JSONLD = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: "Hoy Chat",
  url: PRODUCTION_URL,
  description: DESCRIPTION,
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
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(WEBSITE_JSONLD) }}
        />
        {children}
      </body>
    </html>
  );
}
