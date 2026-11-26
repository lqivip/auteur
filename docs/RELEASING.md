# Releasing AUTEUR

Releases are built by GitHub Actions (`.github/workflows/release.yml`) —
nobody builds release binaries on a local machine.

## Current state (phase 1 → 2 transition)

AUTEUR still ships as a local web app: a Node.js service (`server/`) plus a
statically built React front end (`web/`). The Tauri desktop shell is
**not generated yet** — `src-tauri/` holds only a layout placeholder (see
`src-tauri/README.md`). Until the shell lands, a "release" means CI-verified
build output for all three platforms, not installers.

## How to cut a release

1. **Bump the version** in the root `package.json` (and in
   `server/package.json` / `web/package.json` if they carry the release
   version), commit, and merge to `main`.
2. **Tag the commit** with a `v`-prefixed version and push the tag:

   ```sh
   git tag v0.2.0
   git push origin v0.2.0
   ```

3. **CI builds all three platforms.** The tag push triggers the Release
   workflow, which runs `npm ci` + `npm run build` on `macos-latest`,
   `windows-latest` and `ubuntu-latest` and uploads each platform's
   `server/dist` + `web/dist` as a workflow artifact
   (`auteur-build-<os>`). A red job means that platform does not build —
   fix before announcing the release.
4. **Publish the GitHub Release.** Create the Release from the tag on
   GitHub, write the notes (what changed, known issues), and attach any
   artifacts users should download.

## Once the Tauri shell lands (TODO)

- Generate the Tauri project in `src-tauri/` and bundle the Node server as
  a sidecar binary, per the plan in `src-tauri/README.md`.
- Enable the commented-out `tauri-action` steps at the bottom of
  `.github/workflows/release.yml` (including the Linux system libraries).
- From then on, step 3 above produces real installers — `.dmg` (macOS),
  `.msi`/`.exe` (Windows), `.AppImage`/`.deb` (Linux) — attached to a
  **draft** Release. Review the draft, then publish it manually; step 4
  becomes a review-and-publish check instead of manual artifact wrangling.
- Code signing / notarization (Apple Developer ID, Windows Authenticode)
  is a separate TODO; unsigned builds will show OS warnings on first run.
