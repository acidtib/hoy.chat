import type { Metadata } from "next";
// Fontsource ships the Geist variable font as a local dependency, so the static
// build does not depend on fetching fonts from a network at build time. This is
// the same package the desktop app uses (@fontsource-variable/geist).
import "@fontsource-variable/geist";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hoy, a native desktop GUI for the Pi coding agent",
  description:
    "Hoy is an experimental, pre-1.0 native desktop app for the Pi coding agent. Runs locally, brings your own API key.",
  metadataBase: new URL("https://hoy.chat"),
  openGraph: {
    title: "Hoy",
    description: "A native desktop GUI for the Pi coding agent. Beta, experimental.",
    url: "https://hoy.chat",
    siteName: "Hoy",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
