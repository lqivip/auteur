#!/usr/bin/env node
/**
 * AUTEUR end-to-end smoke test.
 *
 * Boots the ComfyUI stub and the real AUTEUR server (with an isolated
 * AUTEUR_DATA_DIR), then drives the public API through the full production
 * loop: project -> storyboard -> segment -> channel -> discovery -> model ->
 * route -> submit -> poll -> take registered -> base-model read-back
 * verified -> take selected. It also probes the label hard rule, the
 * mismatch branch, cancel/stop semantics, API-key masking, media serving and
 * the built front end.
 *
 * Usage: node scripts/smoke.mjs   (server must be built: npm run build)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STUB_PORT = 18188;
const SERVER_PORT = 14377;
const BASE = `http://127.0.0.1:${SERVER_PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'auteur-smoke-'));

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, pass: Boolean(condition), detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!condition) process.exitCode = 1;
}

async function api(method, url, payload) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: payload !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

/** Extract the ComfyUI "prompt" tEXt chunk (the submitted API workflow) from a PNG. */
function pngPromptJson(buf) {
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'tEXt') {
      const zero = data.indexOf(0);
      if (zero > 0 && data.toString('latin1', 0, zero) === 'prompt') {
        try { return JSON.parse(data.toString('utf8', zero + 1)); } catch { return null; }
      }
    }
    if (type === 'IEND') break;
    offset += 12 + length;
  }
  return null;
}

function nodesByClass(wf, cls) {
  return Object.entries(wf ?? {}).filter(([, n]) => n?.class_type === cls);
}

/** Extract the "prompt" item (the submitted API workflow) from an MP4's
 *  QuickTime metadata: moov/udta/meta -> keys + ilst. Independent
 *  re-implementation, so the stub's writer and the server's reader are
 *  checked against each other, not against themselves. */
function mp4PromptJson(buf) {
  const readBoxes = (start, end) => {
    const out = [];
    let off = start;
    while (off + 8 <= end) {
      let size = buf.readUInt32BE(off);
      const type = buf.toString('latin1', off + 4, off + 8);
      let header = 8;
      if (size === 1) { size = Number(buf.readBigUInt64BE(off + 8)); header = 16; }
      else if (size === 0) size = end - off;
      if (size < header || off + size > end) break;
      out.push({ type, start: off, size, header });
      off += size;
    }
    return out;
  };
  const find = (start, end, type) => readBoxes(start, end).find((b) => b.type === type) ?? null;
  const moov = find(0, buf.length, 'moov');
  if (!moov) return null;
  const udta = find(moov.start + moov.header, moov.start + moov.size, 'udta');
  const meta = udta
    ? find(udta.start + udta.header, udta.start + udta.size, 'meta')
    : find(moov.start + moov.header, moov.start + moov.size, 'meta');
  if (!meta) return null;
  const mStart = meta.start + meta.header + 4;
  const mEnd = meta.start + meta.size;
  const keysBox = find(mStart, mEnd, 'keys');
  const ilstBox = find(mStart, mEnd, 'ilst');
  if (!keysBox || !ilstBox) return null;
  const names = [];
  let off = keysBox.start + keysBox.header + 8;
  const count = buf.readUInt32BE(keysBox.start + keysBox.header + 4);
  for (let i = 0; i < count && off + 8 <= keysBox.start + keysBox.size; i++) {
    const entrySize = buf.readUInt32BE(off);
    names.push(buf.toString('utf8', off + 8, off + entrySize).replace(/\0+$/, ''));
    off += entrySize;
  }
  for (const item of readBoxes(ilstBox.start + ilstBox.header, ilstBox.start + ilstBox.size)) {
    const idx = buf.readUInt32BE(item.start + 4);
    if (names[idx - 1] !== 'prompt') continue;
    const data = find(item.start + item.header, item.start + item.size, 'data');
    if (!data) return null;
    try { return JSON.parse(buf.toString('utf8', data.start + data.header + 8, data.start + data.size)); }
    catch { return null; }
  }
  return null;
}

async function waitFor(fn, timeoutMs, intervalMs = 400) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function startProcess(command, args, env, name) {
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`[${name}] ${d}`));
  child.stderr.on('data', (d) => process.stdout.write(`[${name}:err] ${d}`));
  return child;
}

const stub = startProcess('node', ['tools/stub-comfyui.mjs'], { STUB_PORT: String(STUB_PORT), STUB_RUN_MS: '2500' }, 'stub');
const server = startProcess('node', ['server/dist/index.js'], {
  AUTEUR_DATA_DIR: DATA_DIR,
  AUTEUR_PORT: String(SERVER_PORT),
}, 'server');

async function cleanup() {
  stub.kill('SIGTERM');
  server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));
}
process.on('SIGINT', async () => { await cleanup(); process.exit(130); });

try {
  const healthy = await waitFor(async () => {
    try {
      const r = await fetch(`${BASE}/api/health`);
      return r.ok;
    } catch { return false; }
  }, 15000);
  check('server boots and answers /api/health', healthy, `data dir: ${DATA_DIR}`);

  // --- project / storyboard / segment -------------------------------------
  const project = (await api('POST', '/api/projects', {
    name: 'Smoke Drama', short_name: 'SMK', aspect: '9:16', default_width: 736, default_height: 1280,
  })).data;
  check('create project', Boolean(project.id));

  const storyboard = (await api('POST', `/api/projects/${project.id}/storyboards`, { title: 'Episode 1' })).data;
  check('create storyboard', Boolean(storyboard.id));

  const segment = (await api('POST', `/api/storyboards/${storyboard.id}/segments`, {
    title: 'Opening shot', prompt: 'a lighthouse at dusk, cinematic', dialogue: 'It begins.',
  })).data;
  check('create segment', Boolean(segment.id));

  // --- channel / discovery / model set / model / route --------------------
  const channel = (await api('POST', '/api/channels', {
    name: 'Local Stub ComfyUI', type: 'comfyui', base_url: `http://127.0.0.1:${STUB_PORT}`,
  })).data;
  check('create comfyui channel', Boolean(channel.id));

  const test = (await api('POST', `/api/channels/${channel.id}/test`)).data;
  check('channel connection test', test.ok === true, `nodes: ${test.node_count}`);

  const discovered = (await api('GET', `/api/channels/${channel.id}/discover`)).data;
  check('discover models via /object_info',
    Array.isArray(discovered.unets) && discovered.unets.includes('stub_h3_fl2va.safetensors'),
    `unets: ${(discovered.unets ?? []).join(', ')}`);

  await api('PATCH', `/api/channels/${channel.id}`, { model_files: ['stub_h3_fl2va.safetensors'] });
  const channelAfter = (await api('GET', '/api/channels')).data.find((c) => c.id === channel.id);
  check('model file set saved on channel',
    JSON.stringify(channelAfter.model_files) === JSON.stringify(['stub_h3_fl2va.safetensors']));

  const model = (await api('POST', '/api/models', {
    channel_id: channel.id, name: 'Stub H3 FL2VA', file_name: 'stub_h3_fl2va.safetensors',
    capability: 'text-to-video', adapter: 'comfy-video',
  })).data;
  check('create model', Boolean(model.id));

  const route = (await api('POST', '/api/routes', { project_id: project.id, purpose: 'video', model_id: model.id })).data;
  check('create project video route', Boolean(route.id));

  // --- external channel: key stored locally, masked on read ----------------
  const extChannel = (await api('POST', '/api/channels', {
    name: 'External API', type: 'openai-compatible', base_url: 'https://api.example.invalid/v1',
    api_key: 'sk-smoke-secret-1234567890',
  })).data;
  const channels = (await api('GET', '/api/channels')).data;
  const extRead = channels.find((c) => c.id === extChannel.id);
  check('external channel key masked on read',
    extRead.has_key === true && !JSON.stringify(extRead).includes('sk-smoke-secret-1234567890'),
    `masked: ${extRead.api_key_masked}`);

  // --- label hard rule ------------------------------------------------------
  const blankLabel = await api('POST', `/api/segments/${segment.id}/jobs`, { label: '   ', purpose: 'video' });
  check('blank label rejected (hard rule)', blankLabel.status === 400, blankLabel.data.error ?? '');

  // --- submit -> poll -> take -> verify -> select ---------------------------
  const job = (await api('POST', `/api/segments/${segment.id}/jobs`, {
    label: 'smoke / E1-1 / video', purpose: 'video',
    settings: { frames: 120, prompt: 'a lighthouse at dusk, cinematic' },
  })).data;
  check('submit job via route', Boolean(job.id) && Boolean(job.prompt_id), `prompt_id: ${job.prompt_id}`);
  check('frames snapped to 17k+5 grid in snapshot',
    job.snapshot?.frames === 124 && (job.snapshot?.adjustments ?? []).length > 0,
    `frames: ${job.snapshot?.frames}, adjustments: ${(job.snapshot?.adjustments ?? []).join('; ')}`);

  const completed = await waitFor(async () => {
    const j = (await api('GET', `/api/jobs/${job.id}`)).data;
    return j.status === 'completed' ? j : null;
  }, 30000);
  check('job completes via /queue + /history polling', Boolean(completed), `status: ${completed?.status}`);

  const detail = (await api('GET', `/api/segments/${segment.id}`)).data;
  const take = detail.takes?.[0];
  check('take registered from history outputs', Boolean(take), take ? take.file_name : 'no takes');
  check('base model read back from embedded take metadata',
    take?.actual_model === 'stub_h3_fl2va.safetensors', `actual: ${take?.actual_model}`);
  check('take marked base-model verified', take?.verify_status === 'verified', `verify: ${take?.verify_status}`);

  const mediaRes = await fetch(`${BASE}/media/${take.file_path}`);
  const mediaType = mediaRes.headers.get('content-type') ?? '';
  check('take media served', mediaRes.ok && (mediaType.includes('png') || mediaType.includes('mp4')),
    `content-type: ${mediaType}`);

  const selected = await api('POST', `/api/takes/${take.id}/select`, {});
  check('verified take selectable without force', selected.status === 200);
  const detailAfter = (await api('GET', `/api/segments/${segment.id}`)).data;
  check('segment shows selected take + status',
    detailAfter.segment.selected_take_id === take.id && detailAfter.segment.status === 'selected');

  // --- mismatch branch --------------------------------------------------------
  const mismatchJob = (await api('POST', `/api/segments/${segment.id}/jobs`, {
    label: 'smoke / mismatch probe', purpose: 'video',
    settings: { prompt: 'auteur-mismatch-probe frame' },
  })).data;
  const mismatchDone = await waitFor(async () => {
    const j = (await api('GET', `/api/jobs/${mismatchJob.id}`)).data;
    return j.status === 'completed' ? j : null;
  }, 30000);
  const detail2 = (await api('GET', `/api/segments/${segment.id}`)).data;
  const mismatchTake = detail2.takes.find((tk) => tk.job_id === mismatchJob.id);
  check('mismatch job completes', Boolean(mismatchDone));
  check('embedded model differing from expected -> mismatch',
    mismatchTake?.verify_status === 'mismatch' && mismatchTake?.actual_model === 'some_other_model.safetensors',
    `verify: ${mismatchTake?.verify_status}, actual: ${mismatchTake?.actual_model}`);
  const mismatchSelect = await api('POST', `/api/takes/${mismatchTake.id}/select`, {});
  check('mismatched take not selectable without confirmation', mismatchSelect.status === 409);

  // --- cancel semantics -------------------------------------------------------
  const cancelJob = (await api('POST', `/api/segments/${segment.id}/jobs`, {
    label: 'smoke / cancel probe', purpose: 'video',
  })).data;
  const cancelRes = await api('POST', `/api/jobs/${cancelJob.id}/cancel`);
  check('queued job can be cancelled', cancelRes.status === 200 && cancelRes.data.status === 'cancelled',
    `status: ${cancelRes.data.status ?? cancelRes.data.error}`);
  const cancelCompleted = await api('POST', `/api/jobs/${job.id}/cancel`);
  check('completed job cannot be cancelled', cancelCompleted.status === 400);

  // --- stop semantics -----------------------------------------------------------
  const stopJob = (await api('POST', `/api/segments/${segment.id}/jobs`, {
    label: 'smoke / stop probe', purpose: 'video',
  })).data;
  const running = await waitFor(async () => {
    const j = (await api('GET', `/api/jobs/${stopJob.id}`)).data;
    return j.status === 'running' ? j : null;
  }, 10000);
  check('job reaches running state', Boolean(running));
  const stopRes = await api('POST', `/api/jobs/${stopJob.id}/stop`);
  check('running job accepts stop', stopRes.status === 200 && stopRes.data.status === 'stopping',
    `status: ${stopRes.data.status ?? stopRes.data.error}`);
  const stopped = await waitFor(async () => {
    const j = (await api('GET', `/api/jobs/${stopJob.id}`)).data;
    return j.status === 'stopped' ? j : null;
  }, 15000);
  check('stopping resolves to stopped (no stuck running)', Boolean(stopped), `status: ${stopped?.status}`);

  // --- h3-image adapter: workflow shape + adapter defaults + seedream --------
  const H3_UNET = 'minimax_h3_image_pruned_bf16.safetensors';
  const h3Model = (await api('POST', '/api/models', {
    channel_id: channel.id, name: 'MiniMax H3-Image', file_name: H3_UNET,
    capability: 'text-to-image', adapter: 'h3-image',
  })).data;
  check('create h3-image model (seedream_lora param defaulted off)',
    Boolean(h3Model.id) && JSON.parse(h3Model.params ?? '{}').seedream_lora === false);

  const h3Job = (await api('POST', `/api/segments/${segment.id}/jobs`, {
    label: 'smoke / h3-image', purpose: 'image', model_id: h3Model.id,
    settings: { prompt: 'a lighthouse at dusk, cinematic' },
  })).data;
  check('h3-image job submitted', Boolean(h3Job.id) && Boolean(h3Job.prompt_id), `prompt_id: ${h3Job.prompt_id}`);
  check('h3-image snapshot carries adapter defaults (6 steps / CFG 1 / euler / simple)',
    h3Job.snapshot?.steps === 6 && h3Job.snapshot?.cfg === 1
      && h3Job.snapshot?.sampler === 'euler' && h3Job.snapshot?.scheduler === 'simple'
      && h3Job.snapshot?.seedream_lora === false,
    `steps: ${h3Job.snapshot?.steps}, cfg: ${h3Job.snapshot?.cfg}`);

  const h3Done = await waitFor(async () => {
    const j = (await api('GET', `/api/jobs/${h3Job.id}`)).data;
    return j.status === 'completed' ? j : null;
  }, 30000);
  check('h3-image job completes', Boolean(h3Done));
  const detail3 = (await api('GET', `/api/segments/${segment.id}`)).data;
  const h3Take = detail3.takes.find((tk) => tk.job_id === h3Job.id);
  check('h3-image take base-model verified against the UNET name',
    h3Take?.verify_status === 'verified' && h3Take?.actual_model === H3_UNET,
    `verify: ${h3Take?.verify_status}, actual: ${h3Take?.actual_model}`);

  const h3PngRes = await fetch(`${BASE}/media/${h3Take.file_path}`);
  const h3Wf = pngPromptJson(Buffer.from(await h3PngRes.arrayBuffer()));
  const unetNodes = nodesByClass(h3Wf, 'UNETLoader');
  const clipNodes = nodesByClass(h3Wf, 'CLIPLoader');
  const vaeNodes = nodesByClass(h3Wf, 'VAELoader');
  const samplerNodes = nodesByClass(h3Wf, 'KSampler');
  const decodeNodes = nodesByClass(h3Wf, 'VAEDecode');
  const saveNodes = nodesByClass(h3Wf, 'SaveImage');
  const latentNodes = nodesByClass(h3Wf, 'EmptyLatentImage');
  const encodeNodes = nodesByClass(h3Wf, 'CLIPTextEncode');
  check('h3-image workflow: loader chain (UNET / CLIP minimax / VAE)',
    unetNodes.length === 1 && unetNodes[0][1].inputs.unet_name === H3_UNET
      && clipNodes.length === 1 && clipNodes[0][1].inputs.type === 'minimax'
      && clipNodes[0][1].inputs.clip_name === 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'
      && vaeNodes.length === 1 && vaeNodes[0][1].inputs.vae_name === 'minimax_h3_image_vae_fp16.safetensors');
  const ks = samplerNodes[0]?.[1];
  check('h3-image workflow: sampler defaults + wiring (no LoRA when seedream off)',
    samplerNodes.length === 1 && ks.inputs.steps === 6 && ks.inputs.cfg === 1
      && ks.inputs.sampler_name === 'euler' && ks.inputs.scheduler === 'simple'
      && ks.inputs.model[0] === unetNodes[0][0]
      && ks.inputs.positive[0] === encodeNodes.find(([, n]) => n.inputs.text.length > 0)?.[0]
      && ks.inputs.negative[0] === encodeNodes.find(([, n]) => n.inputs.text === '')?.[0]
      && ks.inputs.latent_image[0] === latentNodes[0]?.[0]
      && nodesByClass(h3Wf, 'LoraLoaderModelOnly').length === 0);
  check('h3-image workflow: decode -> save wiring',
    decodeNodes.length === 1 && decodeNodes[0][1].inputs.samples[0] === samplerNodes[0][0]
      && decodeNodes[0][1].inputs.vae[0] === vaeNodes[0][0]
      && saveNodes.length === 1 && saveNodes[0][1].inputs.images[0] === decodeNodes[0][0]);

  const h3SeedJob = (await api('POST', `/api/segments/${segment.id}/jobs`, {
    label: 'smoke / h3-image seedream', purpose: 'image', model_id: h3Model.id,
    settings: { prompt: 'portrait of a traveller at dawn', seedream_lora: true },
  })).data;
  check('h3-image seedream job snapshot flags the LoRA', h3SeedJob.snapshot?.seedream_lora === true);
  const h3SeedDone = await waitFor(async () => {
    const j = (await api('GET', `/api/jobs/${h3SeedJob.id}`)).data;
    return j.status === 'completed' ? j : null;
  }, 30000);
  check('h3-image seedream job completes', Boolean(h3SeedDone));
  const detail4 = (await api('GET', `/api/segments/${segment.id}`)).data;
  const h3SeedTake = detail4.takes.find((tk) => tk.job_id === h3SeedJob.id);
  const h3SeedPngRes = await fetch(`${BASE}/media/${h3SeedTake.file_path}`);
  const h3SeedWf = pngPromptJson(Buffer.from(await h3SeedPngRes.arrayBuffer()));
  const loraNodes = nodesByClass(h3SeedWf, 'LoraLoaderModelOnly');
  const seedKs = nodesByClass(h3SeedWf, 'KSampler')[0]?.[1];
  const seedPos = nodesByClass(h3SeedWf, 'CLIPTextEncode').find(([, n]) => n.inputs.text.length > 0)?.[1];
  check('h3-image seedream workflow: LoRA in the model chain + trigger word prepended',
    loraNodes.length === 1 && loraNodes[0][1].inputs.lora_name === 'Seedreamstyle_H3_Resume_6K.safetensors'
      && loraNodes[0][1].inputs.strength_model === 1.0
      && loraNodes[0][1].inputs.model[0] === nodesByClass(h3SeedWf, 'UNETLoader')[0][0]
      && seedKs?.inputs.model[0] === loraNodes[0][0]
      && (seedPos?.inputs.text ?? '').startsWith('seedreamstyle. '),
    `prompt: ${seedPos?.inputs.text}`);

  // --- h3-fl2va adapter: first-frame hard rule + workflow shape + mp4 read-back --
  const FL2VA_UNET = 'minimax_h3_fl2va_pruned_int8_convrot.safetensors';
  const { extractBaseModel } = await import(new URL('../server/dist/pngmeta.js', import.meta.url));

  const flModel = (await api('POST', '/api/models', {
    channel_id: channel.id, name: 'MiniMax H3 FL2VA', file_name: FL2VA_UNET,
    capability: 'first-last-frame-to-video', adapter: 'h3-fl2va',
  })).data;
  check('create h3-fl2va model', Boolean(flModel.id));

  const seg2 = (await api('POST', `/api/storyboards/${storyboard.id}/segments`, {
    title: 'FL2VA shot', prompt: 'segment prompt (job overrides this)',
  })).data;
  check('create fl2va segment', Boolean(seg2.id));

  const noFrame = await api('POST', `/api/segments/${seg2.id}/jobs`, {
    label: 'smoke / fl2va no frame', purpose: 'video', model_id: flModel.id, settings: {},
  });
  check('h3-fl2va without a first frame is rejected (hard rule)',
    noFrame.status === 400 && /first frame/i.test(noFrame.data.error ?? ''),
    noFrame.data.error ?? `status ${noFrame.status}`);

  const tinyPngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  const upload = (await api('POST', '/api/uploads', { filename: 'frame.png', data_base64: tinyPngB64 })).data;
  const frameBase = String(upload.path ?? '').split('/').pop();
  check('first frame uploaded to the media library', Boolean(frameBase), upload.path ?? '');

  // Unreadable frame file: the job must fail loudly, never run frameless.
  await api('PATCH', `/api/segments/${seg2.id}`, { first_frame: 'uploads/definitely-missing.png' });
  const failJobRes = await api('POST', `/api/segments/${seg2.id}/jobs`, {
    label: 'smoke / fl2va missing file', purpose: 'video', model_id: flModel.id, settings: {},
  });
  check('h3-fl2va with an unreadable first frame fails submission',
    failJobRes.status === 502, `status: ${failJobRes.status}`);
  const failJobRow = (await api('GET', `/api/jobs/${failJobRes.data.job_id}`)).data;
  check('failed job is marked failed and carries the first-frame error',
    failJobRow.status === 'failed' && /first frame/i.test(failJobRow.error ?? ''),
    failJobRow.error ?? '');

  await api('PATCH', `/api/segments/${seg2.id}`, { first_frame: upload.path });
  const flJob = (await api('POST', `/api/segments/${seg2.id}/jobs`, {
    label: 'smoke / fl2va', purpose: 'video', model_id: flModel.id,
    settings: { frames: 120, prompt: 'she lowers her leg and walks toward camera' },
  })).data;
  check('h3-fl2va job submitted', Boolean(flJob.id) && Boolean(flJob.prompt_id), `prompt_id: ${flJob.prompt_id}`);
  check('h3-fl2va snapshot: adapter defaults (20 steps / res_multistep / simple), frames snapped, frame name recorded',
    flJob.snapshot?.steps === 20 && flJob.snapshot?.sampler === 'res_multistep'
      && flJob.snapshot?.scheduler === 'simple' && flJob.snapshot?.frames === 124
      && flJob.snapshot?.first_frame_name === frameBase,
    `steps: ${flJob.snapshot?.steps}, frames: ${flJob.snapshot?.frames}, frame: ${flJob.snapshot?.first_frame_name}`);

  const flDone = await waitFor(async () => {
    const j = (await api('GET', `/api/jobs/${flJob.id}`)).data;
    return j.status === 'completed' ? j : null;
  }, 30000);
  check('h3-fl2va job completes', Boolean(flDone));
  const seg2Detail = (await api('GET', `/api/segments/${seg2.id}`)).data;
  const flTake = seg2Detail.takes.find((tk) => tk.job_id === flJob.id);
  check('h3-fl2va take registered as a video (mp4)',
    flTake?.kind === 'video' && flTake.file_name.endsWith('.mp4'), flTake?.file_name ?? 'no take');
  check('h3-fl2va base model read back from MP4 metadata -> verified',
    flTake?.actual_model === FL2VA_UNET && flTake?.verify_status === 'verified',
    `verify: ${flTake?.verify_status}, actual: ${flTake?.actual_model}`);

  const uploadsRes = await fetch(`http://127.0.0.1:${STUB_PORT}/__uploads`);
  const uploadsData = await uploadsRes.json();
  check('first frame was uploaded to ComfyUI input before submit',
    (uploadsData.uploads ?? []).includes(frameBase), (uploadsData.uploads ?? []).join(', '));

  const flMp4Res = await fetch(`${BASE}/media/${flTake.file_path}`);
  const flWf = mp4PromptJson(Buffer.from(await flMp4Res.arrayBuffer()));
  const byClass = (cls) => nodesByClass(flWf, cls);
  const unetN = byClass('UNETLoader')[0];
  const clipN = byClass('CLIPLoader')[0];
  const vaeNs = byClass('VAELoader');
  const imgN = byClass('LoadImage')[0];
  const i2vN = byClass('MiniMaxH3ImageToVideo')[0];
  const shiftN = byClass('MiniMaxH3SigmaShift')[0];
  const sigmasN = byClass('BasicScheduler')[0];
  const samplerSelN = byClass('KSamplerSelect')[0];
  const noiseN = byClass('RandomNoise')[0];
  const guiderN = byClass('BasicGuider')[0];
  const sampleN = byClass('SamplerCustomAdvanced')[0];
  const decodeN = byClass('VAEDecode')[0];
  const videoN = byClass('CreateVideo')[0];
  const saveN = byClass('SaveVideo')[0];
  check('fl2va workflow: full production node set present (15 nodes, no last-frame node)',
    Object.keys(flWf ?? {}).length === 15 && Boolean(unetN && clipN && imgN && i2vN && shiftN && sigmasN
      && samplerSelN && noiseN && guiderN && sampleN && decodeN && videoN && saveN)
      && vaeNs.length === 2);
  check('fl2va workflow: loaders (UNET from model record / CLIP minimax / video+audio VAE)',
    unetN?.[1].inputs.unet_name === FL2VA_UNET && unetN?.[1].inputs.weight_dtype === 'default'
      && clipN?.[1].inputs.clip_name === 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'
      && clipN?.[1].inputs.type === 'minimax'
      && vaeNs.some(([, n]) => n.inputs.vae_name === 'minimax_h3_video_vae_fp16.safetensors')
      && vaeNs.some(([, n]) => n.inputs.vae_name === 'minimax_h3_audio_vae_fp32.safetensors'));
  const videoVaeId = vaeNs.find(([, n]) => n.inputs.vae_name === 'minimax_h3_video_vae_fp16.safetensors')?.[0];
  check('fl2va workflow: i2v conditioning (first frame / prompt / size / length)',
    i2vN?.[1].inputs.first_frame?.[0] === imgN?.[0] && imgN?.[1].inputs.image === frameBase
      && i2vN?.[1].inputs.clip?.[0] === clipN?.[0] && i2vN?.[1].inputs.vae?.[0] === videoVaeId
      && i2vN?.[1].inputs.width === 736 && i2vN?.[1].inputs.height === 1280
      && i2vN?.[1].inputs.length === 124
      && i2vN?.[1].inputs.prompt === 'she lowers her leg and walks toward camera');
  check('fl2va workflow: sampling chain (SigmaShift 3/12 -> simple 20 steps -> res_multistep -> guider -> sampler)',
    shiftN?.[1].inputs.model?.[0] === unetN?.[0]
      && shiftN?.[1].inputs.shift_audio === 3 && shiftN?.[1].inputs.shift_video === 12
      && sigmasN?.[1].inputs.model?.[0] === shiftN?.[0] && sigmasN?.[1].inputs.scheduler === 'simple'
      && sigmasN?.[1].inputs.steps === 20 && sigmasN?.[1].inputs.denoise === 1
      && samplerSelN?.[1].inputs.sampler_name === 'res_multistep'
      && noiseN?.[1].inputs.noise_seed === flJob.snapshot?.seed
      && guiderN?.[1].inputs.model?.[0] === shiftN?.[0]
      && guiderN?.[1].inputs.conditioning?.[0] === i2vN?.[0] && guiderN?.[1].inputs.conditioning?.[1] === 0
      && sampleN?.[1].inputs.noise?.[0] === noiseN?.[0] && sampleN?.[1].inputs.guider?.[0] === guiderN?.[0]
      && sampleN?.[1].inputs.sampler?.[0] === samplerSelN?.[0] && sampleN?.[1].inputs.sigmas?.[0] === sigmasN?.[0]
      && sampleN?.[1].inputs.latent_image?.[0] === i2vN?.[0] && sampleN?.[1].inputs.latent_image?.[1] === 1);
  check('fl2va workflow: decode -> CreateVideo (24fps) -> SaveVideo (auto/auto)',
    decodeN?.[1].inputs.samples?.[0] === sampleN?.[0] && decodeN?.[1].inputs.vae?.[0] === videoVaeId
      && videoN?.[1].inputs.images?.[0] === decodeN?.[0] && videoN?.[1].inputs.fps === 24
      && saveN?.[1].inputs.video?.[0] === videoN?.[0] && saveN?.[1].inputs.format === 'auto'
      && saveN?.[1].inputs.codec === 'auto'
      && String(saveN?.[1].inputs.filename_prefix ?? '').startsWith('auteur_'));

  // Optional last frame: a second job with one set must wire img_last -> i2v.
  const upload2 = (await api('POST', '/api/uploads', { filename: 'last.png', data_base64: tinyPngB64 })).data;
  const lastBase = String(upload2.path ?? '').split('/').pop();
  await api('PATCH', `/api/segments/${seg2.id}`, { last_frame: upload2.path });
  const flJob2 = (await api('POST', `/api/segments/${seg2.id}/jobs`, {
    label: 'smoke / fl2va last frame', purpose: 'video', model_id: flModel.id,
    settings: { frames: 39, prompt: 'she lowers her leg and walks toward camera' },
  })).data;
  const flDone2 = await waitFor(async () => {
    const j = (await api('GET', `/api/jobs/${flJob2.id}`)).data;
    return j.status === 'completed' ? j : null;
  }, 30000);
  check('h3-fl2va job with a last frame completes', Boolean(flDone2));
  const seg2Detail2 = (await api('GET', `/api/segments/${seg2.id}`)).data;
  const flTake2 = seg2Detail2.takes.find((tk) => tk.job_id === flJob2.id);
  const flMp4Res2 = await fetch(`${BASE}/media/${flTake2.file_path}`);
  const flWf2 = mp4PromptJson(Buffer.from(await flMp4Res2.arrayBuffer()));
  const loadImages2 = nodesByClass(flWf2, 'LoadImage');
  const i2v2 = nodesByClass(flWf2, 'MiniMaxH3ImageToVideo')[0]?.[1];
  const lastImgNode = loadImages2.find(([, n]) => n.inputs.image === lastBase);
  check('fl2va workflow: optional last frame wired (LoadImage -> i2v.last_frame)',
    loadImages2.length === 2 && Boolean(lastImgNode)
      && i2v2?.inputs.last_frame?.[0] === lastImgNode?.[0]
      && flTake2?.verify_status === 'verified',
    `verify: ${flTake2?.verify_status}`);

  // Real-machine sample: a genuine ComfyUI FL2VA output from production must
  // parse to the production UNET through the server's own reader.
  const realSample = path.join(os.homedir(), 'workspace/douyin-dance-account/ref-froghat/work/segments/fh_s1.mp4');
  if (fs.existsSync(realSample)) {
    const realBuf = fs.readFileSync(realSample);
    check('real ComfyUI mp4 sample (frog-hat seg A): base model parsed from its metadata',
      extractBaseModel(realBuf, 'fh_s1.mp4') === FL2VA_UNET,
      `actual: ${extractBaseModel(realBuf, 'fh_s1.mp4')}`);
  } else {
    console.log('SKIP  real ComfyUI mp4 sample not present on this machine');
  }

  // --- h3-ref2va adapter: reference hard rule + workflow shape + audio branch --
  const REF2VA_UNET = 'minimax_h3_ref2va_pruned_int8_convrot.safetensors';
  const refModel = (await api('POST', '/api/models', {
    channel_id: channel.id, name: 'MiniMax H3 Ref2VA', file_name: REF2VA_UNET,
    capability: 'reference-to-video', adapter: 'h3-ref2va',
  })).data;
  check('create h3-ref2va model', Boolean(refModel.id));

  const seg3 = (await api('POST', `/api/storyboards/${storyboard.id}/segments`, {
    title: 'Ref2VA shot', prompt: 'segment prompt (job overrides this)',
  })).data;
  check('create ref2va segment', Boolean(seg3.id));

  const noRefs = await api('POST', `/api/segments/${seg3.id}/jobs`, {
    label: 'smoke / ref2va no refs', purpose: 'video', model_id: refModel.id, settings: {},
  });
  check('h3-ref2va without reference images is rejected (hard rule)',
    noRefs.status === 400 && /reference image/i.test(noRefs.data.error ?? ''),
    noRefs.data.error ?? `status ${noRefs.status}`);

  const refUpload1 = (await api('POST', '/api/uploads', { filename: 'face.png', data_base64: tinyPngB64 })).data;
  const refUpload2 = (await api('POST', '/api/uploads', { filename: 'scene.png', data_base64: tinyPngB64 })).data;
  const refBase1 = String(refUpload1.path ?? '').split('/').pop();
  const refBase2 = String(refUpload2.path ?? '').split('/').pop();
  await api('PATCH', `/api/segments/${seg3.id}`, { ref_images: [refUpload1.path, refUpload2.path] });
  const seg3Detail0 = (await api('GET', `/api/segments/${seg3.id}`)).data;
  check('segment stores the reference image list (order = <Picture N>)',
    JSON.stringify(seg3Detail0.segment.ref_images) === JSON.stringify([refUpload1.path, refUpload2.path]),
    JSON.stringify(seg3Detail0.segment.ref_images));

  const REF_PROMPT = 'Subject definitions: <Picture 1> shows the face of a night-patrol officer. <Picture 2> shows a teahouse interior at night.\n\nThe video: the officer from <Picture 1> steps into <Picture 2>, static camera.\n\nThe video is completely silent, no audio.';
  const refJob = (await api('POST', `/api/segments/${seg3.id}/jobs`, {
    label: 'smoke / ref2va', purpose: 'video', model_id: refModel.id,
    settings: { frames: 73, prompt: REF_PROMPT },
  })).data;
  check('h3-ref2va job submitted', Boolean(refJob.id) && Boolean(refJob.prompt_id), `prompt_id: ${refJob.prompt_id}`);
  check('h3-ref2va snapshot: adapter defaults (20 steps / res_multistep / simple) + uploaded ref names recorded in order',
    refJob.snapshot?.steps === 20 && refJob.snapshot?.sampler === 'res_multistep'
      && refJob.snapshot?.scheduler === 'simple'
      && JSON.stringify(refJob.snapshot?.ref_image_names) === JSON.stringify([refBase1, refBase2])
      && refJob.snapshot?.ref_image_size === 'match',
    `names: ${JSON.stringify(refJob.snapshot?.ref_image_names)}`);

  const refDone = await waitFor(async () => {
    const j = (await api('GET', `/api/jobs/${refJob.id}`)).data;
    return j.status === 'completed' ? j : null;
  }, 30000);
  check('h3-ref2va job completes', Boolean(refDone));
  const seg3Detail = (await api('GET', `/api/segments/${seg3.id}`)).data;
  const refTake = seg3Detail.takes.find((tk) => tk.job_id === refJob.id);
  check('h3-ref2va take registered as a video (mp4), base model verified from MP4 metadata',
    refTake?.kind === 'video' && refTake.file_name.endsWith('.mp4')
      && refTake?.actual_model === REF2VA_UNET && refTake?.verify_status === 'verified',
    `verify: ${refTake?.verify_status}, actual: ${refTake?.actual_model}`);

  const uploadsRes2 = await fetch(`http://127.0.0.1:${STUB_PORT}/__uploads`);
  const uploadsData2 = await uploadsRes2.json();
  check('both reference images were uploaded to ComfyUI input before submit',
    (uploadsData2.uploads ?? []).includes(refBase1) && (uploadsData2.uploads ?? []).includes(refBase2),
    (uploadsData2.uploads ?? []).join(', '));

  const refMp4Res = await fetch(`${BASE}/media/${refTake.file_path}`);
  const refWf = mp4PromptJson(Buffer.from(await refMp4Res.arrayBuffer()));
  const rByClass = (cls) => nodesByClass(refWf, cls);
  const rUnet = rByClass('UNETLoader')[0];
  const rClip = rByClass('CLIPLoader')[0];
  const rVaes = rByClass('VAELoader');
  const rLoads = rByClass('LoadImage');
  const r2v = rByClass('MiniMaxH3ReferenceToVideo')[0];
  const rShift = rByClass('MiniMaxH3SigmaShift')[0];
  const rSigmas = rByClass('BasicScheduler')[0];
  const rVideo = rByClass('CreateVideo')[0];
  const rVideoVaeId = rVaes.find(([, n]) => n.inputs.vae_name === 'minimax_h3_video_vae_fp16.safetensors')?.[0];
  const rAudioVaeId = rVaes.find(([, n]) => n.inputs.vae_name === 'minimax_h3_audio_vae_fp32.safetensors')?.[0];
  check('ref2va workflow: silent variant node set (16 nodes for 2 refs, no audio branch)',
    Object.keys(refWf ?? {}).length === 16 && Boolean(rUnet && rClip && r2v && rShift && rSigmas && rVideo)
      && rVaes.length === 2 && rLoads.length === 2
      && rByClass('LoadAudio').length === 0 && rByClass('VAEDecodeAudio').length === 0
      && !('audio' in (rVideo?.[1].inputs ?? {})));
  check('ref2va workflow: loaders (UNET from model record / CLIP minimax / video+audio VAE)',
    rUnet?.[1].inputs.unet_name === REF2VA_UNET && rUnet?.[1].inputs.weight_dtype === 'default'
      && rClip?.[1].inputs.clip_name === 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'
      && rClip?.[1].inputs.type === 'minimax' && Boolean(rVideoVaeId) && Boolean(rAudioVaeId));
  const refNode0 = rLoads.find(([, n]) => n.inputs.image === refBase1);
  const refNode1 = rLoads.find(([, n]) => n.inputs.image === refBase2);
  check('ref2va workflow: r2v conditioning (clip/vae/audio_vae, refs in <Picture N> order, size, match, prompt verbatim)',
    r2v?.[1].inputs.clip?.[0] === rClip?.[0] && r2v?.[1].inputs.vae?.[0] === rVideoVaeId
      && r2v?.[1].inputs.audio_vae?.[0] === rAudioVaeId
      && r2v?.[1].inputs['ref_images.ref_image_0']?.[0] === refNode0?.[0]
      && r2v?.[1].inputs['ref_images.ref_image_1']?.[0] === refNode1?.[0]
      && r2v?.[1].inputs.width === 736 && r2v?.[1].inputs.height === 1280
      && r2v?.[1].inputs.length === 73 && r2v?.[1].inputs.ref_image_size === 'match'
      && r2v?.[1].inputs.prompt === REF_PROMPT);
  check('ref2va workflow: sampling chain (SigmaShift 3/12 -> simple 20 steps -> res_multistep -> guider -> sampler -> decode -> 24fps video)',
    rShift?.[1].inputs.model?.[0] === rUnet?.[0]
      && rShift?.[1].inputs.shift_audio === 3 && rShift?.[1].inputs.shift_video === 12
      && rSigmas?.[1].inputs.scheduler === 'simple' && rSigmas?.[1].inputs.steps === 20
      && rByClass('KSamplerSelect')[0]?.[1].inputs.sampler_name === 'res_multistep'
      && rByClass('BasicGuider')[0]?.[1].inputs.conditioning?.[0] === r2v?.[0]
      && rByClass('SamplerCustomAdvanced')[0]?.[1].inputs.latent_image?.[0] === r2v?.[0]
      && rByClass('SamplerCustomAdvanced')[0]?.[1].inputs.latent_image?.[1] === 1
      && rByClass('VAEDecode')[0]?.[1].inputs.vae?.[0] === rVideoVaeId
      && rVideo?.[1].inputs.fps === 24
      && rByClass('SaveVideo')[0]?.[1].inputs.format === 'auto');

  // Unreadable reference file: the job must fail loudly, never run short-handed.
  await api('PATCH', `/api/segments/${seg3.id}`, { ref_images: ['uploads/definitely-missing.png'] });
  const refFailRes = await api('POST', `/api/segments/${seg3.id}/jobs`, {
    label: 'smoke / ref2va missing file', purpose: 'video', model_id: refModel.id, settings: {},
  });
  check('h3-ref2va with an unreadable reference image fails submission',
    refFailRes.status === 502, `status: ${refFailRes.status}`);
  const refFailRow = (await api('GET', `/api/jobs/${refFailRes.data.job_id}`)).data;
  check('failed job is marked failed and carries the reference-image error',
    refFailRow.status === 'failed' && /reference image/i.test(refFailRow.error ?? ''),
    refFailRow.error ?? '');
  await api('PATCH', `/api/segments/${seg3.id}`, { ref_images: [refUpload1.path, refUpload2.path] });

  // Reference audio branch: attaching a voice adds LoadAudio + decodeA and
  // wires CreateVideo.audio, mirroring the production voiced shots.
  const wavB64 = Buffer.from('stub wav bytes for the ref2va smoke').toString('base64');
  const voiceUpload = (await api('POST', '/api/uploads', { filename: 'voice.wav', data_base64: wavB64 })).data;
  const voiceBase = String(voiceUpload.path ?? '').split('/').pop();
  check('reference audio uploaded to the media library', Boolean(voiceBase), voiceUpload.path ?? '');
  await api('PATCH', `/api/segments/${seg3.id}`, { ref_audio: voiceUpload.path });
  const refJobA = (await api('POST', `/api/segments/${seg3.id}/jobs`, {
    label: 'smoke / ref2va voiced', purpose: 'video', model_id: refModel.id,
    settings: { frames: 39, prompt: REF_PROMPT.replace('completely silent, no audio', 'speaks with <Audio 1>') },
  })).data;
  check('h3-ref2va voiced job submitted, snapshot records the uploaded audio name',
    Boolean(refJobA.id) && refJobA.snapshot?.ref_audio_name === voiceBase,
    `audio: ${refJobA.snapshot?.ref_audio_name}`);
  const refDoneA = await waitFor(async () => {
    const j = (await api('GET', `/api/jobs/${refJobA.id}`)).data;
    return j.status === 'completed' ? j : null;
  }, 30000);
  check('h3-ref2va voiced job completes', Boolean(refDoneA));
  const seg3DetailA = (await api('GET', `/api/segments/${seg3.id}`)).data;
  const refTakeA = seg3DetailA.takes.find((tk) => tk.job_id === refJobA.id);
  check('h3-ref2va voiced take base-model verified',
    refTakeA?.verify_status === 'verified' && refTakeA?.actual_model === REF2VA_UNET,
    `verify: ${refTakeA?.verify_status}`);
  const uploadsRes3 = await fetch(`http://127.0.0.1:${STUB_PORT}/__uploads`);
  const uploadsData3 = await uploadsRes3.json();
  check('reference audio was uploaded to ComfyUI input before submit',
    (uploadsData3.uploads ?? []).includes(voiceBase), (uploadsData3.uploads ?? []).join(', '));
  const refMp4ResA = await fetch(`${BASE}/media/${refTakeA.file_path}`);
  const refWfA = mp4PromptJson(Buffer.from(await refMp4ResA.arrayBuffer()));
  const aByClass = (cls) => nodesByClass(refWfA, cls);
  const aLoadAudio = aByClass('LoadAudio')[0];
  const aR2v = aByClass('MiniMaxH3ReferenceToVideo')[0];
  const aDecodeA = aByClass('VAEDecodeAudio')[0];
  const aVideo = aByClass('CreateVideo')[0];
  const aAudioVaeId = aByClass('VAELoader').find(([, n]) => n.inputs.vae_name === 'minimax_h3_audio_vae_fp32.safetensors')?.[0];
  check('ref2va workflow: voiced variant adds the audio branch (LoadAudio -> r2v ref_audios, VAEDecodeAudio -> CreateVideo.audio)',
    Object.keys(refWfA ?? {}).length === 18
      && aLoadAudio?.[1].inputs.audio === voiceBase
      && aR2v?.[1].inputs['ref_audios.ref_audio_0']?.[0] === aLoadAudio?.[0]
      && aDecodeA?.[1].inputs.vae?.[0] === aAudioVaeId
      && aVideo?.[1].inputs.audio?.[0] === aDecodeA?.[0],
    `nodes: ${Object.keys(refWfA ?? {}).length}`);

  // --- front end ------------------------------------------------------------------
  const home = await fetch(`${BASE}/`);
  const homeHtml = await home.text();
  check('built front end served at /', home.ok && homeHtml.includes('id="root"') && homeHtml.includes('AUTEUR'));

  const failed = results.filter((r) => !r.pass);
  console.log(`\nSMOKE SUMMARY: ${results.length - failed.length}/${results.length} passed; data dir kept at ${DATA_DIR}`);
} finally {
  await cleanup();
}
