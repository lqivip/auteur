# Releasing AUTEUR

Releases are built by GitHub Actions (`.github/workflows/release.yml`) —
nobody builds release binaries on a local machine.

## Current state (phase 2)

The Tauri 2 desktop shell has landed (`src-tauri/`, see
`src-tauri/README.md`): the Node server ships as a single-executable
sidecar (Node SEA, built by `scripts/build-sidecar.mjs`), and the
release workflow packages real installers — `.dmg` (macOS),
`.msi`/`.exe` (Windows), `.AppImage`/`.deb` (Linux) — attached to a
**draft** GitHub Release for manual review before publishing.

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
   workflow on `macos-latest`, `windows-latest` and `ubuntu-latest`.
   Each runner installs dependencies, builds the web UI and the server,
   builds the platform's SEA sidecar, expands the app icon, and runs
   `tauri-action`, which packages the installers and attaches them to
   a draft Release named after the tag. A red job means that platform
   does not build — fix before announcing the release.
4. **Review and publish the GitHub Release.** Open the draft Release
   CI created from the tag, write the notes (what changed, known
   issues), check the installer assets are all attached, then publish
   manually. Nothing goes public before this human review.

## Still TODO

- Code signing / notarization (Apple Developer ID, Windows
  Authenticode) is a separate TODO; unsigned builds will show OS
  warnings on first run.
- The root `package.json` version and `src-tauri/tauri.conf.json`
  version should move together with `server/`/`web/` at bump time;
  only the tag is load-bearing for CI.
