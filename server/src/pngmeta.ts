import zlib from 'node:zlib';

/**
 * Read the base model (UNET / Checkpoint) actually used for a PNG produced by
 * ComfyUI. ComfyUI embeds the full API-format workflow as JSON in a PNG text
 * chunk under the key "prompt". We parse tEXt / zTXt / iTXt chunks, find that
 * JSON and pull the loader node inputs out of it.
 *
 * Returns null when the file is not a PNG or carries no readable workflow
 * metadata — the caller then marks the take "unverified".
 */
export function extractBaseModelFromPng(buf: Buffer): string | null {
  const workflow = extractPromptJson(buf);
  if (!workflow) return null;
  return findLoaderModel(workflow);
}

export function extractPromptJson(buf: Buffer): Record<string, any> | null {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  let offset = 8;
  let promptText: string | null = null;
  let workflowText: string | null = null;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd > buf.length) break;
    const data = buf.subarray(dataStart, dataEnd);
    if (type === 'tEXt') {
      const zero = data.indexOf(0);
      if (zero > 0) {
        const key = data.toString('latin1', 0, zero);
        const value = data.toString('utf8', zero + 1);
        if (key === 'prompt') promptText = value;
        if (key === 'workflow') workflowText = value;
      }
    } else if (type === 'zTXt') {
      const zero = data.indexOf(0);
      if (zero > 0 && data[zero + 1] === 0) {
        const key = data.toString('latin1', 0, zero);
        try {
          const value = zlib.inflateSync(data.subarray(zero + 2)).toString('utf8');
          if (key === 'prompt') promptText = value;
          if (key === 'workflow') workflowText = value;
        } catch { /* ignore corrupt chunk */ }
      }
    } else if (type === 'iTXt') {
      const parsed = parseITXt(data);
      if (parsed) {
        if (parsed.key === 'prompt') promptText = parsed.value;
        if (parsed.key === 'workflow') workflowText = parsed.value;
      }
    }
    if (type === 'IEND') break;
    offset = dataEnd + 4; // skip CRC
  }
  for (const text of [promptText, workflowText]) {
    if (!text) continue;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        // API-format workflow is a flat map of node id -> node object.
        if (promptText === text || findLoaderModel(parsed)) return parsed;
      }
    } catch { /* not JSON */ }
  }
  return null;
}

function parseITXt(data: Buffer): { key: string; value: string } | null {
  const zero = data.indexOf(0);
  if (zero < 0) return null;
  const key = data.toString('latin1', 0, zero);
  const compressionFlag = data[zero + 1];
  let pos = zero + 3; // skip compression flag + method
  const langEnd = data.indexOf(0, pos);
  if (langEnd < 0) return null;
  pos = langEnd + 1;
  const translatedEnd = data.indexOf(0, pos);
  if (translatedEnd < 0) return null;
  pos = translatedEnd + 1;
  let raw = data.subarray(pos);
  if (compressionFlag === 1) {
    try { raw = zlib.inflateSync(raw); } catch { return null; }
  }
  return { key, value: raw.toString('utf8') };
}

export function findLoaderModel(workflow: Record<string, any>): string | null {
  const nodes = Array.isArray(workflow) ? workflow : Object.values(workflow);
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const inputs = node.inputs ?? {};
    const classType: string = node.class_type ?? node.type ?? '';
    if (classType === 'UNETLoader' && typeof inputs.unet_name === 'string') return inputs.unet_name;
    if (classType === 'CheckpointLoaderSimple' && typeof inputs.ckpt_name === 'string') return inputs.ckpt_name;
    if (classType === 'CheckpointLoader' && typeof inputs.ckpt_name === 'string') return inputs.ckpt_name;
  }
  // Fallback: any node carrying unet_name / ckpt_name inputs.
  for (const node of nodes) {
    const inputs = node?.inputs ?? {};
    if (typeof inputs.unet_name === 'string') return inputs.unet_name;
    if (typeof inputs.ckpt_name === 'string') return inputs.ckpt_name;
  }
  return null;
}

/* -------------------------------- MP4 --------------------------------- */

/**
 * Read the base model actually used for an MP4/MOV produced by ComfyUI.
 * CreateVideo/SaveVideo write the full API-format workflow as the "prompt"
 * item of the QuickTime metadata block (moov/udta/meta: a "keys" box naming
 * the items, an "ilst" box carrying them). We walk the box tree, pull that
 * JSON out and reuse the PNG loader extraction. No external tools (ffprobe
 * etc.) are involved, so this works identically on every platform.
 *
 * Fallback: if the box walk finds nothing (unusual muxer layout), scan the
 * raw bytes for the loader file name inside the embedded JSON text.
 */
export function extractBaseModelFromMp4(buf: Buffer): string | null {
  const workflow = extractPromptJsonFromMp4(buf);
  if (workflow) {
    const model = findLoaderModel(workflow);
    if (model) return model;
  }
  const text = buf.toString('latin1');
  const m = /"(?:unet_name|ckpt_name)"\s*:\s*"([^"]+)"/.exec(text);
  return m?.[1] ?? null;
}

export function extractPromptJsonFromMp4(buf: Buffer): Record<string, any> | null {
  if (buf.length < 8 || buf.toString('latin1', 4, 8) !== 'ftyp') return null;
  const items = readMp4MetaItems(buf);
  const promptText = items?.get('prompt');
  if (!promptText) return null;
  try {
    const parsed = JSON.parse(promptText);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

interface Mp4Box { type: string; start: number; size: number; header: number }

function* mp4Boxes(buf: Buffer, start: number, end: number): Generator<Mp4Box> {
  let off = start;
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    let header = 8;
    if (size === 1) {
      if (off + 16 > end) break;
      size = Number(buf.readBigUInt64BE(off + 8));
      header = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < header || off + size > end) break;
    yield { type, start: off, size, header };
    off += size;
  }
}

function findBox(buf: Buffer, start: number, end: number, type: string): Mp4Box | null {
  for (const box of mp4Boxes(buf, start, end)) if (box.type === type) return box;
  return null;
}

/** Locate the meta box: normally moov/udta/meta, occasionally moov/meta. */
function findMetaBox(buf: Buffer): Mp4Box | null {
  const moov = findBox(buf, 0, buf.length, 'moov');
  if (!moov) return null;
  const contentStart = moov.start + moov.header;
  const contentEnd = moov.start + moov.size;
  const udta = findBox(buf, contentStart, contentEnd, 'udta');
  if (udta) {
    const meta = findBox(buf, udta.start + udta.header, udta.start + udta.size, 'meta');
    if (meta) return meta;
  }
  return findBox(buf, contentStart, contentEnd, 'meta');
}

function readMp4MetaItems(buf: Buffer): Map<string, string> | null {
  const meta = findMetaBox(buf);
  if (!meta) return null;
  // meta carries a 4-byte version/flags prefix before its child boxes.
  const start = meta.start + meta.header + 4;
  const end = meta.start + meta.size;
  const keysBox = findBox(buf, start, end, 'keys');
  const ilstBox = findBox(buf, start, end, 'ilst');
  if (!keysBox || !ilstBox) return null;

  // keys: version/flags (4) + entry count (4), then per entry:
  // size (4) + namespace (4, "mdta") + name bytes (may be NUL-terminated).
  const names: string[] = [];
  {
    let off = keysBox.start + keysBox.header + 4;
    const keysEnd = keysBox.start + keysBox.size;
    if (off + 4 > keysEnd) return null;
    const count = buf.readUInt32BE(off);
    off += 4;
    for (let i = 0; i < count && off + 8 <= keysEnd; i++) {
      const entrySize = buf.readUInt32BE(off);
      if (entrySize < 8 || off + entrySize > keysEnd) break;
      names.push(buf.toString('utf8', off + 8, off + entrySize).replace(/\0+$/, ''));
      off += entrySize;
    }
  }

  // ilst: each child box's "type" is the 1-based index into the keys list;
  // inside it, a "data" box holds type (4) + locale (4) + the raw value.
  const items = new Map<string, string>();
  for (const item of mp4Boxes(buf, ilstBox.start + ilstBox.header, ilstBox.start + ilstBox.size)) {
    const index = buf.readUInt32BE(item.start + 4);
    const name = names[index - 1];
    if (!name) continue;
    const data = findBox(buf, item.start + item.header, item.start + item.size, 'data');
    if (!data) continue;
    const valueStart = data.start + data.header + 8;
    const valueEnd = data.start + data.size;
    if (valueStart > valueEnd) continue;
    items.set(name, buf.toString('utf8', valueStart, valueEnd));
  }
  return items.size > 0 ? items : null;
}

/**
 * Generic metadata read for any output file. PNG and MP4/MOV carry the
 * embedded workflow; other containers (webm...) return null and their
 * takes stay "unverified".
 */
export function extractBaseModel(buf: Buffer, fileName: string): string | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.png')) return extractBaseModelFromPng(buf);
  if (lower.endsWith('.mp4') || lower.endsWith('.mov') || lower.endsWith('.m4v')) return extractBaseModelFromMp4(buf);
  return null;
}
