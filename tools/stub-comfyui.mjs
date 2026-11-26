#!/usr/bin/env node
/**
 * Minimal ComfyUI stub for AUTEUR smoke tests.
 *
 * Implements just enough of the ComfyUI HTTP API:
 *   GET  /object_info          model file lists for UNET / checkpoint / LoRA
 *   POST /prompt               accepts a workflow, returns { prompt_id, number }
 *   GET  /queue                running / pending lists (ComfyUI wire shape)
 *   GET  /history/:id          completed entry with one PNG or MP4 output
 *   GET  /view                 serves the generated PNG / MP4
 *   POST /queue {delete:[id]}  removes a pending prompt
 *   POST /interrupt            drops the running prompt (no history entry)
 *   POST /upload/image         accepts a frame upload, returns its name
 *   GET  /__uploads            stub-only debug: names uploaded so far
 *
 * Execution is simulated: pending -> running after ~0.6s -> done after
 * ~STUB_RUN_MS (default 2500ms). Image workflows (SaveImage) produce a PNG
 * embedding the workflow as a "prompt" tEXt chunk; video workflows
 * (SaveVideo / CreateVideo) produce an MP4 whose QuickTime metadata
 * (moov/udta/meta keys+ilst) carries the workflow as the "prompt" item —
 * both exactly like real ComfyUI, so AUTEUR's base-model read-back
 * verification can be exercised end to end.
 *
 * Probe: if the workflow JSON contains the string "auteur-mismatch-probe",
 * the embedded metadata names a different UNET than the one submitted, which
 * lets the smoke test exercise the "mismatch" verification branch.
 */
import http from 'node:http';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const PORT = Number(process.env.STUB_PORT ?? 18188);
const RUN_MS = Number(process.env.STUB_RUN_MS ?? 2500);
const EMBED_MODEL_OVERRIDE = 'some_other_model.safetensors';

const UNETS = ['minimax_h3_fl2va_pruned_int8_convrot.safetensors', 'minimax_h3_ref2va_pruned_int8_convrot.safetensors', 'stub_h3_fl2va.safetensors', 'stub_h3_ref2va.safetensors', 'stub_unet_small.safetensors'];
const CHECKPOINTS = ['stub_photo_v1.safetensors', 'stub_anime_v2.safetensors'];
const LORAS = ['stub_style_a.safetensors', 'stub_detail_b.safetensors'];

/* ------------------------------ PNG writer ----------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function makePng(promptJson) {
  const width = 8;
  const height = 8;
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const p = rowStart + 1 + x * 3;
      raw[p] = 90 + x * 10;
      raw[p + 1] = 60 + y * 12;
      raw[p + 2] = 160;
    }
  }
  const text = Buffer.concat([
    Buffer.from('prompt', 'latin1'),
    Buffer.from([0]),
    Buffer.from(promptJson, 'utf8'),
  ]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', (() => {
      const ihdr = Buffer.alloc(13);
      ihdr.writeUInt32BE(width, 0);
      ihdr.writeUInt32BE(height, 4);
      ihdr[8] = 8; // bit depth
      ihdr[9] = 2; // color type RGB
      return ihdr;
    })()),
    chunk('tEXt', text),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------ MP4 writer ----------------------------- */

/**
 * Minimal MP4 carrying the workflow JSON in the same place real ComfyUI
 * (CreateVideo/SaveVideo) puts it: moov/udta/meta, a "keys" box naming the
 * items ("prompt", "encoder") and an "ilst" box whose data payload for the
 * "prompt" item is the JSON text. The media data is a stub payload — the
 * file exists to exercise metadata read-back, not to play.
 */
function mp4Box(type, payload) {
  const typeBuf = Buffer.isBuffer(type) ? type : Buffer.from(type, 'latin1');
  const out = Buffer.alloc(8 + payload.length);
  out.writeUInt32BE(out.length, 0);
  typeBuf.copy(out, 4);
  payload.copy(out, 8);
  return out;
}

function makeMp4(promptJson) {
  const ftyp = mp4Box('ftyp', Buffer.concat([
    Buffer.from('isom', 'latin1'),
    Buffer.from([0, 0, 2, 0]),
    Buffer.from('isomiso2avc1mp41', 'latin1'),
  ]));
  const hdlr = mp4Box('hdlr', Buffer.concat([
    Buffer.alloc(8), // version/flags + pre_defined
    Buffer.from('mdta', 'latin1'),
    Buffer.alloc(12), // reserved
    Buffer.from([0]), // name, NUL-terminated
  ]));
  const keyNames = ['prompt', 'encoder'];
  const keyEntries = keyNames.map((name) => {
    const nameBuf = Buffer.from(name, 'utf8');
    const entry = Buffer.alloc(8 + nameBuf.length);
    entry.writeUInt32BE(entry.length, 0);
    entry.write('mdta', 4, 'latin1');
    nameBuf.copy(entry, 8);
    return entry;
  });
  const keysHead = Buffer.alloc(8); // version/flags + entry count
  keysHead.writeUInt32BE(keyNames.length, 4);
  const keys = mp4Box('keys', Buffer.concat([keysHead, ...keyEntries]));
  const dataBox = (text) => {
    const payload = Buffer.alloc(8);
    payload.writeUInt32BE(1, 0); // value type 1 = UTF-8 text; locale stays 0
    return mp4Box('data', Buffer.concat([payload, Buffer.from(text, 'utf8')]));
  };
  const item = (index, text) => {
    const typeBuf = Buffer.alloc(4);
    typeBuf.writeUInt32BE(index, 0); // ilst item "type" is the 1-based keys index
    return mp4Box(typeBuf, dataBox(text));
  };
  const ilst = mp4Box('ilst', Buffer.concat([item(1, promptJson), item(2, 'stub-comfyui')]));
  const meta = mp4Box('meta', Buffer.concat([Buffer.alloc(4), hdlr, keys, ilst]));
  const moov = mp4Box('moov', mp4Box('udta', meta));
  const mdat = mp4Box('mdat', Buffer.from('stub-video-data', 'latin1'));
  return Buffer.concat([ftyp, moov, mp4Box('free', Buffer.alloc(0)), mdat]);
}

/* ------------------------------ stub state ----------------------------- */

const jobs = new Map(); // id -> { workflow, number, state, media, fileName, kind, saveNodeId }
const uploads = []; // names accepted via /upload/image, in order
let counter = 0;

function embeddedWorkflow(workflow) {
  const copy = JSON.parse(JSON.stringify(workflow));
  if (JSON.stringify(workflow).includes('auteur-mismatch-probe')) {
    for (const node of Object.values(copy)) {
      if (node && node.class_type === 'UNETLoader' && node.inputs) node.inputs.unet_name = EMBED_MODEL_OVERRIDE;
      if (node && node.class_type === 'CheckpointLoaderSimple' && node.inputs) node.inputs.ckpt_name = EMBED_MODEL_OVERRIDE;
    }
  }
  return copy;
}

function schedule(job) {
  job.startTimer = setTimeout(() => {
    if (job.state === 'pending') job.state = 'running';
    job.doneTimer = setTimeout(() => {
      if (job.state !== 'running') return;
      job.state = 'done';
      // Video workflows (SaveVideo / CreateVideo nodes) yield an MP4 with
      // QuickTime-style metadata; everything else yields a PNG as before.
      const nodes = Object.entries(job.workflow);
      const saveVideo = nodes.find(([, n]) => n?.class_type === 'SaveVideo');
      const saveImage = nodes.find(([, n]) => n?.class_type === 'SaveImage');
      const isVideo = Boolean(saveVideo) || nodes.some(([, n]) => n?.class_type === 'CreateVideo');
      const metaJson = JSON.stringify(embeddedWorkflow(job.workflow));
      if (isVideo) {
        job.kind = 'video';
        job.saveNodeId = saveVideo?.[0] ?? '9';
        job.fileName = `stub_${job.id.slice(0, 8)}_00001.mp4`;
        job.media = makeMp4(metaJson);
      } else {
        job.kind = 'image';
        job.saveNodeId = saveImage?.[0] ?? '5';
        job.fileName = `stub_${job.id.slice(0, 8)}_00001.png`;
        job.media = makePng(metaJson);
      }
    }, RUN_MS);
  }, 600);
}

const objectInfo = {
  UNETLoader: { input: { required: { unet_name: [UNETS], weight_dtype: [['default', 'fp8_e4m3fn']] } } },
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [CHECKPOINTS] } } },
  LoraLoader: { input: { required: { lora_name: [LORAS] } } },
  CLIPTextEncode: { input: { required: { text: ['STRING'] } } },
  KSampler: { input: { required: { seed: ['INT'], steps: ['INT'], cfg: ['FLOAT'] } } },
};

function queueEntry(job) {
  return [job.number, job.id, job.workflow, {}, []];
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://stub');
  const send = (status, data, type = 'application/json') => {
    const body = Buffer.isBuffer(data) ? data : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
    res.writeHead(status, { 'content-type': type });
    res.end(body);
  };
  const readBody = (cb) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => cb(Buffer.concat(chunks)));
  };

  if (req.method === 'GET' && url.pathname === '/object_info') return send(200, objectInfo);

  if (req.method === 'POST' && url.pathname === '/prompt') {
    return readBody((buf) => {
      const parsed = JSON.parse(buf.toString('utf8') || '{}');
      const id = crypto.randomUUID();
      const job = { id, workflow: parsed.prompt ?? {}, number: ++counter, state: 'pending', media: null, fileName: null, kind: 'image', saveNodeId: '5' };
      jobs.set(id, job);
      schedule(job);
      send(200, { prompt_id: id, number: job.number, node_errors: {} });
    });
  }

  if (req.method === 'GET' && url.pathname === '/queue') {
    const running = [];
    const pending = [];
    for (const job of jobs.values()) {
      if (job.state === 'running') running.push(queueEntry(job));
      if (job.state === 'pending') pending.push(queueEntry(job));
    }
    return send(200, { queue_running: running, queue_pending: pending });
  }

  if (req.method === 'POST' && url.pathname === '/queue') {
    return readBody((buf) => {
      const parsed = JSON.parse(buf.toString('utf8') || '{}');
      for (const id of parsed.delete ?? []) {
        const job = jobs.get(id);
        if (job && job.state === 'pending') {
          clearTimeout(job.startTimer);
          jobs.delete(id);
        }
      }
      send(200, {});
    });
  }

  if (req.method === 'POST' && url.pathname === '/interrupt') {
    for (const [id, job] of jobs) {
      if (job.state === 'running') {
        clearTimeout(job.doneTimer);
        jobs.delete(id); // interrupted prompts leave no history entry
      }
    }
    return send(200, {});
  }

  if (req.method === 'GET' && url.pathname.startsWith('/history/')) {
    const id = decodeURIComponent(url.pathname.slice('/history/'.length));
    const job = jobs.get(id);
    if (!job || job.state !== 'done') return send(200, {});
    const file = { filename: job.fileName, subfolder: '', type: 'output' };
    const outputs = job.kind === 'video'
      ? { [job.saveNodeId]: { videos: [file] } }
      : { [job.saveNodeId]: { images: [file] } };
    return send(200, {
      [id]: {
        prompt: job.workflow,
        outputs,
        status: { status_str: 'success', completed: true, messages: [] },
      },
    });
  }

  if (req.method === 'GET' && url.pathname === '/view') {
    const filename = url.searchParams.get('filename');
    for (const job of jobs.values()) {
      if (job.fileName === filename && job.media) {
        return send(200, job.media, job.kind === 'video' ? 'video/mp4' : 'image/png');
      }
    }
    return send(404, { error: 'not found' });
  }

  if (req.method === 'POST' && url.pathname === '/upload/image') {
    return readBody((buf) => {
      const match = /filename="([^"]+)"/.exec(buf.toString('latin1'));
      const name = match?.[1] ?? 'uploaded.png';
      uploads.push(name);
      send(200, { name, subfolder: '', type: 'input' });
    });
  }

  if (req.method === 'GET' && url.pathname === '/__uploads') {
    return send(200, { uploads });
  }

  send(404, { error: `stub: no route ${req.method} ${url.pathname}` });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`ComfyUI stub listening on http://127.0.0.1:${PORT}`);
});
