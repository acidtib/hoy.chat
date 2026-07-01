import { REPO_URL, RELEASES_URL } from "./site";

// Direct-download config. Asset filenames match what Tauri's bundler emits (see a
// real release via `gh release view`): the productName "Hoy Desktop" becomes
// "Hoy.Desktop" and the version is embedded, so every link is built per-version.
// GitHub serves the file directly at /releases/download/v<version>/<file>, so the
// buttons pull the actual installer rather than dropping the visitor on a list.

export type OS = "macos" | "windows" | "linux";

export interface DownloadAsset {
  label: string;
  file: (v: string) => string;
}

export interface OSDownload {
  os: OS;
  name: string;
  primaryLabel: string;
  assets: DownloadAsset[];
  note: string;
}

export const OS_LABEL: Record<OS, string> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
};

export function assetUrl(version: string, file: string): string {
  return `${REPO_URL}/releases/download/v${version}/${file}`;
}

export const RELEASES_LIST_URL = RELEASES_URL;

export const OS_DOWNLOADS: Record<OS, OSDownload> = {
  macos: {
    os: "macos",
    name: "macOS",
    primaryLabel: "Apple Silicon",
    assets: [
      { label: "Apple Silicon", file: (v) => `Hoy.Desktop_${v}_aarch64.dmg` },
      { label: "Intel", file: (v) => `Hoy.Desktop_${v}_x64.dmg` },
    ],
    note: "First launch: right-click Hoy, choose Open. Unsigned build, so Gatekeeper warns once.",
  },
  windows: {
    os: "windows",
    name: "Windows",
    primaryLabel: "Installer",
    assets: [
      { label: "Installer", file: (v) => `Hoy.Desktop_${v}_x64-setup.exe` },
      { label: "MSI", file: (v) => `Hoy.Desktop_${v}_x64_en-US.msi` },
    ],
    note: "SmartScreen warns on first run: choose More info, then Run anyway. Unsigned build.",
  },
  linux: {
    os: "linux",
    name: "Linux",
    primaryLabel: "AppImage",
    assets: [
      { label: "AppImage", file: (v) => `Hoy.Desktop_${v}_amd64.AppImage` },
      { label: ".deb", file: (v) => `Hoy.Desktop_${v}_amd64.deb` },
      { label: ".rpm", file: (v) => `Hoy.Desktop-${v}-1.x86_64.rpm` },
    ],
    note: "AppImage needs chmod +x before it runs; or install the .deb / .rpm. No apt repo yet.",
  },
};

export const OS_ORDER: OS[] = ["macos", "windows", "linux"];
