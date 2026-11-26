# AUTEUR

**AI 短剧生产台 / AI Short-Drama Production Desk / AI短編ドラマ制作デスク**

*Status: Phase 1 — core production chain complete and verified against a
real ComfyUI on Apple Silicon.*

A local-first production desk for AI short dramas and short-form video,
built for creators who run ComfyUI on their own machine. AUTEUR ships no
models and no hosted backend: **you bring your own local ComfyUI install
and your own model files** (e.g. MiniMax H3 image/video weights), and
AUTEUR orchestrates them.

Organize work as **Project → Storyboard → Segment**, submit generation jobs
to a local ComfyUI (or an external OpenAI-compatible API), and manage every
resulting take — with the production discipline baked in: mandatory job
labels, aspect/resolution/frame snapshots at submission time, and automatic
**base-model read-back verification** (the model actually used is read from
the output file's embedded metadata and compared with what the job asked
for).

All code and copy in this repository are original.

## Stack

TypeScript end to end:

- `web/` — React + Vite front end (built to static files).
- `server/` — Node.js (Express) local service + SQLite via the built-in
  `node:sqlite` module, so there are no native dependencies to compile.
- `src-tauri/` — packaging placeholder. Phase 2 wraps the same front end and
  service into Windows / macOS / Linux installers with Tauri 2 (see
  `src-tauri/README.md`).

## Install & run

Prerequisites: Node.js 20+ (Node 22+ recommended for `node:sqlite`).

```bash
# install dependencies (server + web)
npm run install:all

# build everything (server -> server/dist, web -> web/dist)
npm run build

# start the service (serves the API and the built front end)
npm start
```

Then open <http://127.0.0.1:4377>.

Development mode (hot reload, two terminals):

```bash
npm run dev:server   # API on http://127.0.0.1:4377
npm run dev:web      # Vite on http://127.0.0.1:5173, proxies /api and /media
```

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `AUTEUR_DATA_DIR` | OS app-data dir | Where the database, config and media live. Windows `%APPDATA%\Auteur`, macOS `~/Library/Application Support/Auteur`, Linux `~/.local/share/auteur`. Never the install directory. |
| `AUTEUR_PORT` | `4377` | Service port. |
| `AUTEUR_HOST` | `127.0.0.1` | Bind address. |

ComfyUI channels are configured in the Settings UI (default address
`http://127.0.0.1:8188`). To link against a ComfyUI on another machine, just
point the channel's base URL at it, e.g. `http://192.168.1.10:8188`.

## Concepts

- **Channel → Model → Route.** A channel is a ComfyUI instance (models are
  discovered from `GET /object_info`; you can pin a "model file set" so only
  chosen files are exposed) or an external OpenAI-compatible API (base URL +
  API key; the key is stored only in the local data directory and is always
  masked when read back). A route maps a purpose (`video` / `image`) to a
  model, per project or per segment.
- **Jobs.** Every job requires a non-empty label (blank labels are rejected
  by the API). At submission the effective settings are snapshotted:
  project aspect, width/height snapped to multiples of 32, frame counts
  snapped to the `17k+5` grid (22, 39, 56, 73, 90, 124…), seed resolved.
- **Cancel vs Stop.** *Cancel* removes a still-queued job from the ComfyUI
  queue. *Stop* interrupts a running job; the service reconciles against
  `/queue` and `/history` until the job settles as *stopped* — nothing can
  stay "running" forever.
- **Takes & verification.** When a job completes, outputs are downloaded and
  registered as takes. For PNG outputs the embedded workflow metadata is
  read back and the real UNET/checkpoint name is compared with the job's
  expected model: `verified`, `unverified` (no readable metadata) or
  `mismatch`. Unverified/mismatched takes are never auto-selected, and
  selecting one manually requires explicit confirmation.
- **i18n.** Dictionary-based UI in Simplified Chinese, English and Japanese.
  On first launch the system language is used when supported, otherwise
  English; the switcher in the sidebar/settings changes it instantly.

## Smoke test

A stub ComfyUI (`tools/stub-comfyui.mjs`) implements `/prompt`, `/queue`,
`/history`, `/object_info`, `/view`, `/upload/image`, queue deletion and
interrupt, and returns PNGs with embedded workflow metadata just like the
real thing.

```bash
npm run build
npm run smoke
```

See `SMOKE.md` for the latest run and what it covers.

## Phase-1 scope notes

- Base-model read-back is implemented for PNG outputs and for mp4 video
  outputs (the embedded workflow metadata is parsed and the real UNET name
  compared with the job's expectation).
- Built-in ComfyUI adapters cover MiniMax H3 image generation plus the
  FL2VA (first/last-frame) and Ref2VA (reference-image, optional
  reference-audio) video workflows, alongside a generic
  loader → sampler → save workflow; per-model production workflows can be
  added as new adapters without touching the bridge.
- External (OpenAI-compatible) image generation is supported; external takes
  are marked `unverified` because the model name is API-reported rather than
  embedded in the file.
