import type { Metadata, Viewport } from "next";
import Script from "next/script";
// Fontsource ships the Geist variable font as a local dependency, so the static
// build does not depend on fetching fonts from a network at build time. This is
// the same package the desktop app uses (@fontsource-variable/geist).
import "@fontsource-variable/geist";
import "./globals.css";
import { SITE_URL, IS_PRODUCTION, canonical, PRODUCTION_URL } from "@/lib/site";

const DESCRIPTION =
  "Local. Fast. Yours. Hoy gives your coding agent a real desktop app, wired to the models and tools you already use, running on your own machine, on your keys. Beta, rough edges included.";

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
    "bring your own API keys",
  ],
  // Every deploy consolidates to the production apex; the beta stays out of the
  // index entirely until it becomes that apex.
  alternates: { canonical: canonical("/") },
  robots: IS_PRODUCTION ? undefined : { index: false, follow: false },
  openGraph: {
    title: "Hoy Chat, a desktop app for coding agents",
    description: "Your coding agent in a real desktop app. Local, on your own keys, still in beta.",
    url: SITE_URL,
    siteName: "Hoy Chat",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Hoy Chat, a desktop app for coding agents",
    description: "Your coding agent in a real desktop app. Local, on your own keys, still in beta.",
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
    // suppressHydrationWarning: the beforeInteractive js-flag script adds the
    // `js` class to <html> before hydration (intentionally not server-rendered,
    // so no-JS never hides reveal content); body suppression absorbs attributes
    // injected by browser extensions (e.g. cz-shortcut-listen).
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>
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
