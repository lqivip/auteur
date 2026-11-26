# Tauri packaging (phase 2 placeholder)

Phase 1 ships as a local web app: a Node.js service plus a statically built
React front end. The code base is already laid out the way Tauri 2 expects:

- `web/` builds to static files (`web/dist`) — this becomes the Tauri
  front-end bundle.
- `server/` is a plain Node HTTP service with no POSIX-only shell hooks; in
  phase 2 it will be bundled as a Tauri sidecar binary and started/stopped
  with the app.
- All user data lives in the OS application-data directory (see
  `server/src/config.ts`), never in the install directory, so installers for
  Windows (.msi), macOS (.dmg) and Linux (.AppImage/.deb) need no data
  migration logic.

No Tauri project is generated yet; this directory only reserves the layout.
