# Flatpak / Flathub

A ready manifest that repacks the release `.deb` into a Flatpak. Mechanically it
works; whether it's a good experience is the open question (see below).

## Files

- `chat.hoy.desktop.yml` — flatpak-builder manifest.
- `chat.hoy.desktop.metainfo.xml` — AppStream metainfo (Flathub requires it; still
  needs a real screenshot before submission).

## Build and test locally

```sh
flatpak install flathub org.gnome.Platform//46 org.gnome.Sdk//46
flatpak-builder --user --install --force-clean build-dir chat.hoy.desktop.yml
flatpak run chat.hoy.desktop
```

Bump the `.deb` `url` + `sha256` in the manifest and the `<release>` in the
metainfo per version.

## The caveat: sandbox vs. coding agent

Hoy runs the `pi` agent, which edits the user's files and runs their toolchain.
Flatpak sandboxes exactly that, so the manifest already grants `--share=network`
and `--filesystem=host`, and to run host tools the sidecar would need to route
command execution through `flatpak-spawn --host` (it doesn't today). Until that
integration exists, a Flatpak build's agent can only use the GNOME runtime's
tools, not the user's real `git`/`node`/`cargo`.

So this is checked in as a scaffold, not a shipping recommendation. Pick it up when
we decide the `flatpak-spawn` work and Flathub review are worth it. The signed
pacman repo (`../pacman-repo`) is the recommended Linux channel for now.

## Submitting to Flathub (when ready)

1. Add a real screenshot to the metainfo and host it.
2. Fork `github.com/flathub/flathub`, add a branch named `chat.hoy.desktop`, drop
   the manifest in, open a PR.
3. After review + merge you get a per-app repo you update going forward.
