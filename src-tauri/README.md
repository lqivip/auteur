# Tauri desktop shell

AUTEUR ships as a Tauri 2 desktop app. The shell (`src/lib.rs`) is thin
by design:

1. It starts the Node server, bundled as a **sidecar binary**
   (`binaries/auteur-server-<target-triple>`, declared as
   `bundle.externalBin` in `tauri.conf.json`).
2. It waits until the server answers `GET /api/health` on
   127.0.0.1:4377.
3. It opens the single app window (1280×800, title "AUTEUR") on the
   server's own origin — the server serves the built web UI itself.
4. On app exit it kills the sidecar.

## Data and web-dist plumbing

- The shell passes `AUTEUR_DATA_DIR` = Tauri's per-OS application-data
  directory for `ai.lqivip.auteur` (e.g. macOS
  `~/Library/Application Support/ai.lqivip.auteur`), reusing the
  server's existing env override. User data never lives in the
  install directory.
- The installer carries `web/dist` as a bundle resource
  (`bundle.resources` maps `../web/dist` → `web/dist`); the shell
  passes its absolute path as `AUTEUR_WEB_DIST`, which the server
  prefers over its source-tree relative resolution (that resolution
  cannot work inside a single-executable bundle).

## Building the sidecar

```sh
npm run sidecar          # host platform, into src-tauri/binaries/
npm run sidecar:verify   # …and boot it against a temp data dir, checking /api/health
```

`scripts/build-sidecar.mjs` compiles the server, bundles it to one
CJS file with esbuild, and injects it into a copy of the current Node
binary with Node's SEA mechanism + postject. Sidecar binaries are
build outputs — gitignored, rebuilt by CI per platform.

## Icons

`icons/icon.png` (512×512, dark panel + gold "A") is the source icon.
The release workflow expands it to the full platform set
(`cargo tauri icon`) before packaging; the generated sizes are what
`tauri.conf.json` lists.

## Local development

```sh
npm run install:all
npm run sidecar          # the shell needs the sidecar binary present
npm run tauri:dev        # or tauri:build for a local installer
```

Note: the window always loads the local server's origin, in dev too —
the server serves the production `web/dist` build. (`build.devUrl` in
`tauri.conf.json` stays at the Vite default for a future HMR setup;
the Vite dev server itself proxies /api to 127.0.0.1:4377 when used
standalone via `npm run dev:web`.)

## Known gaps

- No code signing / notarization yet; unsigned builds show OS
  first-run warnings (see docs/RELEASING.md).
- If port 4377 is already taken (e.g. a manually started server), the
  shell's health wait succeeds against that instance and the sidecar
  it spawned exits — the window still works, but the stray sidecar
  error is only visible on stderr.
