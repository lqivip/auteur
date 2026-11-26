#!/usr/bin/env node
/**
 * Build the AUTEUR server as a single-executable sidecar (Node SEA).
 *
 * Pipeline: tsc build -> esbuild single-file CJS bundle -> SEA blob ->
 * copy of the current Node binary -> postject injection. The result is
 * written to src-tauri/binaries/auteur-server-<target-triple>[.exe],
 * which is exactly where tauri.conf.json's bundle.externalBin looks.
 *
 * Usage:
 *   node scripts/build-sidecar.mjs [--triple <rust-target-triple>] [--verify]
 *
 * The triple defaults to the host platform/arch mapping below; CI passes
 * the Rust target triple of the runner explicitly. The Node version that
 * runs this script is the Node version embedded in the sidecar, so build
 * with the same Node major the project targets (22+).
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = path.join(root, 'server');
const binDir = path.join(root, 'src-tauri', 'binaries');
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const HOST_TRIPLES = {
  'linux/x64': 'x86_64-unknown-linux-gnu',
  'linux/arm64': 'aarch64-unknown-linux-gnu',
  'darwin/x64': 'x86_64-apple-darwin',
  'darwin/arm64': 'aarch64-apple-darwin',
  'win32/x64': 'x86_64-pc-windows-msvc',
};

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function run(cmd, args, opts = {}) {
  console.log(`+ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

function bin(name) {
  const p = path.join(serverDir, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);
  if (!fs.existsSync(p)) {
    throw new Error(`${name} not found at ${p} — run "npm --prefix server install" first.`);
  }
  return p;
}

const triple = arg('--triple') ?? process.env.AUTEUR_TARGET_TRIPLE ?? HOST_TRIPLES[`${process.platform}/${process.arch}`];
if (!triple) {
  throw new Error(`No target-triple mapping for ${process.platform}/${process.arch}; pass --triple explicitly.`);
}
const isWin = triple.includes('windows');
const outFile = path.join(binDir, `auteur-server-${triple}${isWin ? '.exe' : ''}`);

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'auteur-sea-'));
try {
  // 1. Fresh TypeScript build of the server.
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  run(npm, ['--prefix', 'server', 'run', 'build'], { cwd: root });

  // 2. Single-file CJS bundle. Node built-ins (express deps are pure JS;
  // node:sqlite and friends) stay external under platform=node.
  const bundle = path.join(work, 'bundle.cjs');
  run(bin('esbuild'), [
    path.join(serverDir, 'dist', 'index.js'),
    '--bundle', '--platform=node', '--format=cjs', '--target=node22',
    `--outfile=${bundle}`,
  ]);

  // 3. SEA blob.
  const blob = path.join(work, 'sea-prep.blob');
  const seaConfig = path.join(work, 'sea-config.json');
  fs.writeFileSync(seaConfig, JSON.stringify({
    main: bundle,
    output: blob,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
  }, null, 2));
  run(process.execPath, ['--experimental-sea-config', seaConfig]);

  // 4. Copy the current Node binary and inject the blob.
  fs.mkdirSync(binDir, { recursive: true });
  fs.copyFileSync(process.execPath, outFile);
  if (process.platform === 'darwin') {
    // The copied binary must be unsigned before injection, then re-signed
    // ad hoc, or macOS refuses to run it.
    try { execFileSync('codesign', ['--remove-signature', outFile], { stdio: 'inherit' }); } catch { /* unsigned already */ }
  }
  const postjectArgs = [outFile, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', SEA_FUSE];
  if (triple.includes('apple')) postjectArgs.push('--macho-segment-name', 'NODE_SEA');
  run(bin('postject'), postjectArgs);
  if (process.platform === 'darwin') {
    run('codesign', ['--sign', '-', outFile]);
  }
  if (!isWin) fs.chmodSync(outFile, 0o755);

  const sizeMb = (fs.statSync(outFile).size / 1048576).toFixed(1);
  console.log(`Sidecar built: ${path.relative(root, outFile)} (${sizeMb} MiB, Node ${process.version}, triple ${triple})`);

  // 5. Optional smoke check: boot it against a throwaway data dir and
  // require a 200 from /api/health.
  if (process.argv.includes('--verify')) {
    const port = 4400 + (process.pid % 400);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auteur-sea-data-'));
    const webDist = path.join(root, 'web', 'dist');
    console.log(`Verifying: ${outFile} on 127.0.0.1:${port}`);
    const child = spawn(outFile, [], {
      env: { ...process.env, AUTEUR_DATA_DIR: dataDir, AUTEUR_PORT: String(port), AUTEUR_HOST: '127.0.0.1', AUTEUR_WEB_DIST: webDist },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.on('data', (d) => process.stderr.write(`[sidecar] ${d}`));
    try {
      let body = '';
      const deadline = Date.now() + 30000;
      for (;;) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/api/health`);
          body = await res.text();
          if (res.status === 200) break;
        } catch { /* not up yet */ }
        if (Date.now() > deadline) throw new Error('sidecar did not answer /api/health within 30s');
        await new Promise((r) => setTimeout(r, 400));
      }
      console.log(`Verify OK: GET /api/health -> 200 ${body}`);
    } finally {
      child.kill('SIGTERM');
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
