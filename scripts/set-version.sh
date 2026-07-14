#!/usr/bin/env bash
# Single source for the app version. Writes the same x.y.z into the files that
# must agree for a release: the root workspace package.json, the desktop and site
# package.json files, Tauri's updater version, and the Rust package version.
#
# Usage: scripts/set-version.sh <x.y.z>
# Release flow: scripts/set-version.sh x.y.z && git commit -am "vx.y.z" &&
#               git tag vx.y.z && git push --tags
set -euo pipefail

VERSION="${1:?usage: scripts/set-version.sh <x.y.z>}"
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "error: version must be x.y.z (got '$VERSION')" >&2
  exit 1
fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# First-occurrence regex replace (no JSON reformatting). bun is the project's
# package manager, so it is always available where this runs.
VERSION="$VERSION" ROOT="$ROOT" bun --eval '
  const fs = require("fs");
  const v = process.env.VERSION, root = process.env.ROOT;
  const set = (rel, re, rep) => {
    const p = root + "/" + rel;
    const s = fs.readFileSync(p, "utf8");
    if (!re.test(s)) throw new Error("no version field in " + rel);
    fs.writeFileSync(p, s.replace(re, rep));
  };
  set("package.json", /"version": "[^"]*"/, `"version": "${v}"`);
  set("apps/desktop/package.json", /"version": "[^"]*"/, `"version": "${v}"`);
  set("apps/site/package.json", /"version": "[^"]*"/, `"version": "${v}"`);
  set("apps/desktop/src-tauri/tauri.conf.json", /"version": "[^"]*"/, `"version": "${v}"`);
  set("apps/desktop/src-tauri/Cargo.toml", /^version = "[^"]*"/m, `version = "${v}"`);
  // Keep Cargo.lock in sync so the committed lockfile matches Cargo.toml.
  set(
    "apps/desktop/src-tauri/Cargo.lock",
    /(name = "hoy-desktop"\nversion = )"[^"]*"/,
    `$1"${v}"`,
  );
  // Bun records workspace package versions in its lockfile.
  set(
    "bun.lock",
    /("apps\/desktop": \{\n\s+"name": "hoy-desktop",\n\s+"version": )"[^"]*"/,
    `$1"${v}"`,
  );
  set(
    "bun.lock",
    /("apps\/site": \{\n\s+"name": "@hoy\/site",\n\s+"version": )"[^"]*"/,
    `$1"${v}"`,
  );
'

echo "set version to $VERSION in root, desktop, site, Tauri, Cargo, and lockfiles"
