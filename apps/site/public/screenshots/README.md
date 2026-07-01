# Product screenshots

Drop real Hoy Desktop captures here to fill the "See it work" section on the
landing page. The gallery is driven by `lib/screenshots.ts`: each entry renders
only when its file exists at build time, so missing files are simply skipped (no
placeholder or broken images ever ship).

Expected files (16:10 works best; they are cropped to that ratio, top-left):

- `sidebar.png` , session sidebar listing conversations by project
- `streaming.png` , a thread streaming an assistant reply
- `tool-calls.png` , tool calls rendering inline (edits, command output)
- `model-selector.png` , the model selector open

Capture from the dev app (`bun run tauri:dev`, the hoyd namespace). To add or
reorder shots, edit the `MANIFEST` in `lib/screenshots.ts`.
