import { Router, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { all, get, run, uid, now } from './db.js';
import { DATA_DIR, MEDIA_DIR } from './config.js';
import {
  comfyObjectInfo, comfySubmit, comfyDeleteFromQueue, comfyInterrupt, discoverModelFiles,
} from './comfy.js';
import {
  buildComfyWorkflow, submitOpenAIImage, snapFrames, snapTo32,
  ADAPTER_DEFAULTS, adapterParamDefaults, type GenSettings,
} from './adapters.js';

export const api = Router();

function ok(res: Response, data: any, status = 200): void {
  res.status(status).json(data);
}
function fail(res: Response, status: number, message: string, extra: Record<string, any> = {}): void {
  res.status(status).json({ error: message, ...extra });
}
function body(req: Request): any {
  return (req.body ?? {}) as Record<string, any>;
}

/* ------------------------------ projects ------------------------------ */

function projectCounts(projectId: string): { segments: number; completed_segments: number } {
  const row = get<any>(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN s.selected_take_id IS NOT NULL THEN 1 ELSE 0 END) AS done
       FROM segments s JOIN storyboards sb ON sb.id = s.storyboard_id
      WHERE sb.project_id = ?`,
    projectId,
  );
  return { segments: row?.total ?? 0, completed_segments: row?.done ?? 0 };
}

api.get('/projects', (_req, res) => {
  const rows = all('SELECT * FROM projects ORDER BY updated_at DESC');
  ok(res, rows.map((p) => ({ ...p, ...projectCounts(p.id) })));
});

api.post('/projects', (req, res) => {
  const b = body(req);
  if (!b.name?.trim()) return fail(res, 400, 'Project name is required');
  const id = uid();
  const t = now();
  run(
    `INSERT INTO projects (id, name, short_name, aspect, aspect_custom, default_width, default_height, archived, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    id, b.name.trim(), b.short_name ?? '', b.aspect ?? '9:16', b.aspect_custom ?? null,
    b.default_width ?? 736, b.default_height ?? 1280, t, t,
  );
  ok(res, get('SELECT * FROM projects WHERE id = ?', id), 201);
});

api.get('/projects/:id', (req, res) => {
  const p = get('SELECT * FROM projects WHERE id = ?', req.params.id);
  if (!p) return fail(res, 404, 'Project not found');
  ok(res, { ...p, ...projectCounts(p.id) });
});

api.patch('/projects/:id', (req, res) => {
  const p = get('SELECT * FROM projects WHERE id = ?', req.params.id);
  if (!p) return fail(res, 404, 'Project not found');
  const b = body(req);
  const fields: Record<string, any> = {
    name: b.name, short_name: b.short_name, aspect: b.aspect, aspect_custom: b.aspect_custom,
    default_width: b.default_width, default_height: b.default_height, archived: b.archived,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) run(`UPDATE projects SET ${key} = ? WHERE id = ?`, value, p.id);
  }
  run('UPDATE projects SET updated_at = ? WHERE id = ?', now(), p.id);
  ok(res, get('SELECT * FROM projects WHERE id = ?', p.id));
});

api.delete('/projects/:id', (req, res) => {
  const p = get('SELECT * FROM projects WHERE id = ?', req.params.id);
  if (!p) return fail(res, 404, 'Project not found');
  const confirm = req.query.confirm === 'true' || body(req).confirm === true;
  if (!confirm) return fail(res, 400, 'Deleting a project requires confirm=true (job records are deleted; media files stay in the data directory)');
  run('DELETE FROM projects WHERE id = ?', p.id);
  ok(res, { deleted: true });
});

/* ---------------------------- storyboards ----------------------------- */

api.post('/projects/:id/storyboards', (req, res) => {
  const p = get('SELECT * FROM projects WHERE id = ?', req.params.id);
  if (!p) return fail(res, 404, 'Project not found');
  const b = body(req);
  const count = get<any>('SELECT COUNT(*) AS c FROM storyboards WHERE project_id = ?', p.id)?.c ?? 0;
  const id = uid();
  run(
    'INSERT INTO storyboards (id, project_id, seq, title, note, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, p.id, b.seq ?? count + 1, b.title ?? '', b.note ?? '', count, now(),
  );
  ok(res, get('SELECT * FROM storyboards WHERE id = ?', id), 201);
});

api.patch('/storyboards/:id', (req, res) => {
  const sb = get('SELECT * FROM storyboards WHERE id = ?', req.params.id);
  if (!sb) return fail(res, 404, 'Storyboard not found');
  const b = body(req);
  for (const key of ['seq', 'title', 'note', 'sort'] as const) {
    if (b[key] !== undefined) run(`UPDATE storyboards SET ${key} = ? WHERE id = ?`, b[key], sb.id);
  }
  ok(res, get('SELECT * FROM storyboards WHERE id = ?', sb.id));
});

api.delete('/storyboards/:id', (req, res) => {
  run('DELETE FROM storyboards WHERE id = ?', req.params.id);
  ok(res, { deleted: true });
});

/* ------------------------------ segments ------------------------------ */

/** Parse the segments.ref_images JSON column into an array for the API. */
export function parseRefImages(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch { /* fall through */ }
  }
  return [];
}

function shapeSegment<T extends Record<string, any>>(seg: T): T {
  return { ...seg, ref_images: parseRefImages(seg.ref_images), ref_audio: seg.ref_audio ?? null };
}

function segmentStatus(seg: any): string {
  if (seg.selected_take_id) return 'selected';
  const active = get<any>(
    `SELECT COUNT(*) AS c FROM jobs WHERE segment_id = ? AND status IN ('queued','running','stopping')`,
    seg.id,
  )?.c ?? 0;
  if (active > 0) return 'queued';
  const takes = get<any>('SELECT COUNT(*) AS c FROM takes WHERE segment_id = ?', seg.id)?.c ?? 0;
  return takes > 0 ? 'produced' : 'none';
}

api.get('/projects/:id/board', (req, res) => {
  const p = get('SELECT * FROM projects WHERE id = ?', req.params.id);
  if (!p) return fail(res, 404, 'Project not found');
  const storyboards = all('SELECT * FROM storyboards WHERE project_id = ? ORDER BY sort, seq', p.id).map((sb: any) => {
    const segments = all('SELECT * FROM segments WHERE storyboard_id = ? ORDER BY sort, seq', sb.id)
      .map((seg: any) => ({ ...shapeSegment(seg), status: segmentStatus(seg) }));
    return { ...sb, segments };
  });
  ok(res, { project: p, storyboards });
});

api.post('/storyboards/:id/segments', (req, res) => {
  const sb = get('SELECT * FROM storyboards WHERE id = ?', req.params.id);
  if (!sb) return fail(res, 404, 'Storyboard not found');
  const b = body(req);
  const count = get<any>('SELECT COUNT(*) AS c FROM segments WHERE storyboard_id = ?', sb.id)?.c ?? 0;
  const id = uid();
  const t = now();
  run(
    `INSERT INTO segments (id, storyboard_id, seq, title, dialogue, prompt, ref_images, ref_audio, sort, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, sb.id, b.seq ?? count + 1, b.title ?? '', b.dialogue ?? '', b.prompt ?? '',
    b.ref_images !== undefined ? JSON.stringify(parseRefImages(b.ref_images)) : null,
    b.ref_audio ?? null, count, t, t,
  );
  ok(res, shapeSegment(get('SELECT * FROM segments WHERE id = ?', id)), 201);
});

api.get('/segments/:id', (req, res) => {
  const seg = get<any>('SELECT * FROM segments WHERE id = ?', req.params.id);
  if (!seg) return fail(res, 404, 'Segment not found');
  const sb = get<any>('SELECT * FROM storyboards WHERE id = ?', seg.storyboard_id);
  const project = sb ? get('SELECT * FROM projects WHERE id = ?', sb.project_id) : null;
  const takes = all('SELECT * FROM takes WHERE segment_id = ? ORDER BY created_at DESC', seg.id);
  const jobs = all('SELECT * FROM jobs WHERE segment_id = ? ORDER BY submitted_at DESC', seg.id);
  ok(res, { segment: { ...shapeSegment(seg), status: segmentStatus(seg) }, storyboard: sb, project, takes, jobs });
});

api.patch('/segments/:id', (req, res) => {
  const seg = get('SELECT * FROM segments WHERE id = ?', req.params.id);
  if (!seg) return fail(res, 404, 'Segment not found');
  const b = body(req);
  const keys = ['seq', 'title', 'dialogue', 'prompt', 'first_frame', 'last_frame', 'ref_audio', 'aspect_override', 'width', 'height',
    'frames', 'fps', 'steps', 'cfg', 'seed', 'sampler', 'scheduler', 'sort'] as const;
  for (const key of keys) {
    if (b[key] !== undefined) run(`UPDATE segments SET ${key} = ? WHERE id = ?`, b[key], seg.id);
  }
  if (b.ref_images !== undefined) {
    run('UPDATE segments SET ref_images = ? WHERE id = ?', JSON.stringify(parseRefImages(b.ref_images)), seg.id);
  }
  run('UPDATE segments SET updated_at = ? WHERE id = ?', now(), seg.id);
  ok(res, shapeSegment(get('SELECT * FROM segments WHERE id = ?', seg.id)));
});

api.post('/segments/:id/duplicate', (req, res) => {
  const seg = get<any>('SELECT * FROM segments WHERE id = ?', req.params.id);
  if (!seg) return fail(res, 404, 'Segment not found');
  const id = uid();
  const t = now();
  const count = get<any>('SELECT COUNT(*) AS c FROM segments WHERE storyboard_id = ?', seg.storyboard_id)?.c ?? 0;
  run(
    `INSERT INTO segments (id, storyboard_id, seq, title, dialogue, prompt, first_frame, last_frame, ref_images, ref_audio, aspect_override,
       width, height, frames, fps, steps, cfg, seed, sampler, scheduler, sort, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, seg.storyboard_id, count + 1, seg.title, seg.dialogue, seg.prompt, seg.first_frame, seg.last_frame,
    seg.ref_images, seg.ref_audio, seg.aspect_override,
    seg.width, seg.height, seg.frames, seg.fps, seg.steps, seg.cfg, seg.seed, seg.sampler, seg.scheduler,
    count, t, t,
  );
  ok(res, shapeSegment(get('SELECT * FROM segments WHERE id = ?', id)), 201);
});

api.delete('/segments/:id', (req, res) => {
  run('DELETE FROM segments WHERE id = ?', req.params.id);
  ok(res, { deleted: true });
});

/* ----------------------------- characters ----------------------------- */

api.get('/projects/:id/characters', (req, res) => {
  const chars = all('SELECT * FROM characters WHERE project_id = ? ORDER BY created_at', req.params.id).map((c: any) => ({
    ...c,
    images: all('SELECT * FROM character_images WHERE character_id = ? ORDER BY created_at', c.id),
  }));
  ok(res, chars);
});

api.post('/projects/:id/characters', (req, res) => {
  const p = get('SELECT * FROM projects WHERE id = ?', req.params.id);
  if (!p) return fail(res, 404, 'Project not found');
  const b = body(req);
  if (!b.name?.trim()) return fail(res, 400, 'Character name is required');
  const id = uid();
  run('INSERT INTO characters (id, project_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)',
    id, p.id, b.name.trim(), b.description ?? '', now());
  ok(res, get('SELECT * FROM characters WHERE id = ?', id), 201);
});

api.delete('/characters/:id', (req, res) => {
  run('DELETE FROM characters WHERE id = ?', req.params.id);
  ok(res, { deleted: true });
});

api.post('/characters/:id/images', (req, res) => {
  const c = get('SELECT * FROM characters WHERE id = ?', req.params.id);
  if (!c) return fail(res, 404, 'Character not found');
  const b = body(req);
  if (!b.path) return fail(res, 400, 'Image path (media-relative) is required');
  const id = uid();
  run(
    'INSERT INTO character_images (id, character_id, path, version, usage, is_current, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, c.id, b.path, b.version ?? '', b.usage ?? '', b.is_current ? 1 : 0, now(),
  );
  if (b.is_current) run('UPDATE character_images SET is_current = 0 WHERE character_id = ? AND id != ?', c.id, id);
  ok(res, get('SELECT * FROM character_images WHERE id = ?', id), 201);
});

api.post('/character-images/:id/current', (req, res) => {
  const img = get<any>('SELECT * FROM character_images WHERE id = ?', req.params.id);
  if (!img) return fail(res, 404, 'Character image not found');
  run('UPDATE character_images SET is_current = 0 WHERE character_id = ?', img.character_id);
  run('UPDATE character_images SET is_current = 1 WHERE id = ?', img.id);
  ok(res, get('SELECT * FROM character_images WHERE id = ?', img.id));
});

api.delete('/character-images/:id', (req, res) => {
  run('DELETE FROM character_images WHERE id = ?', req.params.id);
  ok(res, { deleted: true });
});

/* ------------------------------ uploads ------------------------------- */

// Images feed frame/reference slots; audio files feed the h3-ref2va
// reference-voice slot. Both land in the same media library.
const ALLOWED_UPLOAD_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'wav', 'mp3', 'flac', 'ogg', 'm4a']);

api.post('/uploads', (req, res) => {
  const b = body(req);
  const ext = String(b.filename ?? 'image.png').split('.').pop()?.toLowerCase() ?? 'png';
  if (!ALLOWED_UPLOAD_EXT.has(ext)) return fail(res, 400, `Unsupported file type: ${ext}`);
  if (!b.data_base64) return fail(res, 400, 'data_base64 is required');
  const fileName = `${uid()}.${ext}`;
  const relPath = path.posix.join('uploads', fileName);
  fs.writeFileSync(path.join(MEDIA_DIR, relPath), Buffer.from(String(b.data_base64), 'base64'));
  ok(res, { path: relPath }, 201);
});

/* ------------------------------ channels ------------------------------ */

function maskKey(key: string | null): string | null {
  if (!key) return null;
  if (key.length <= 8) return '••••••••';
  return `${key.slice(0, 3)}••••••${key.slice(-4)}`;
}

function shapeChannel(row: any): any {
  if (!row) return row;
  const { api_key, ...rest } = row;
  return {
    ...rest,
    model_files: JSON.parse(row.model_files ?? '[]'),
    has_key: Boolean(api_key),
    api_key_masked: maskKey(api_key),
  };
}

api.get('/channels', (_req, res) => {
  ok(res, all('SELECT * FROM channels ORDER BY created_at').map(shapeChannel));
});

api.post('/channels', (req, res) => {
  const b = body(req);
  if (!b.name?.trim()) return fail(res, 400, 'Channel name is required');
  if (b.type !== 'comfyui' && b.type !== 'openai-compatible') return fail(res, 400, 'type must be comfyui or openai-compatible');
  if (!b.base_url?.trim()) return fail(res, 400, 'base_url is required');
  const id = uid();
  const t = now();
  run(
    `INSERT INTO channels (id, name, type, base_url, api_key, enabled, model_files, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, b.name.trim(), b.type, b.base_url.trim(), b.api_key ?? null, b.enabled === false ? 0 : 1,
    JSON.stringify(b.model_files ?? []), t, t,
  );
  ok(res, shapeChannel(get('SELECT * FROM channels WHERE id = ?', id)), 201);
});

api.patch('/channels/:id', (req, res) => {
  const ch = get<any>('SELECT * FROM channels WHERE id = ?', req.params.id);
  if (!ch) return fail(res, 404, 'Channel not found');
  const b = body(req);
  if (b.name !== undefined) run('UPDATE channels SET name = ? WHERE id = ?', b.name, ch.id);
  if (b.base_url !== undefined) run('UPDATE channels SET base_url = ? WHERE id = ?', b.base_url, ch.id);
  if (b.enabled !== undefined) run('UPDATE channels SET enabled = ? WHERE id = ?', b.enabled ? 1 : 0, ch.id);
  if (b.model_files !== undefined) run('UPDATE channels SET model_files = ? WHERE id = ?', JSON.stringify(b.model_files), ch.id);
  // API key: only overwrite when a real new key is supplied; a masked value or
  // empty string means "keep the stored key".
  if (typeof b.api_key === 'string' && b.api_key.length > 0 && !b.api_key.includes('•')) {
    run('UPDATE channels SET api_key = ? WHERE id = ?', b.api_key, ch.id);
  }
  if (b.clear_key === true) run('UPDATE channels SET api_key = NULL WHERE id = ?', ch.id);
  run('UPDATE channels SET updated_at = ? WHERE id = ?', now(), ch.id);
  ok(res, shapeChannel(get('SELECT * FROM channels WHERE id = ?', ch.id)));
});

api.delete('/channels/:id', (req, res) => {
  run('DELETE FROM channels WHERE id = ?', req.params.id);
  ok(res, { deleted: true });
});

api.post('/channels/:id/test', async (req, res) => {
  const ch = get<any>('SELECT * FROM channels WHERE id = ?', req.params.id);
  if (!ch) return fail(res, 404, 'Channel not found');
  try {
    if (ch.type === 'comfyui') {
      const info = await comfyObjectInfo(ch.base_url);
      ok(res, { ok: true, kind: 'comfyui', node_count: Object.keys(info).length, models: discoverModelFiles(info) });
    } else {
      const r = await fetch(`${ch.base_url.replace(/\/+$/, '')}/models`, {
        headers: ch.api_key ? { authorization: `Bearer ${ch.api_key}` } : {},
      });
      ok(res, { ok: r.ok, kind: 'openai-compatible', http_status: r.status });
    }
  } catch (err: any) {
    ok(res, { ok: false, error: String(err?.message ?? err) });
  }
});

api.get('/channels/:id/discover', async (req, res) => {
  const ch = get<any>('SELECT * FROM channels WHERE id = ?', req.params.id);
  if (!ch) return fail(res, 404, 'Channel not found');
  if (ch.type !== 'comfyui') return fail(res, 400, 'Model discovery is only available for ComfyUI channels');
  try {
    const info = await comfyObjectInfo(ch.base_url);
    ok(res, { ...discoverModelFiles(info), model_files: JSON.parse(ch.model_files ?? '[]') });
  } catch (err: any) {
    fail(res, 502, `Discovery failed: ${err?.message ?? err}`);
  }
});

/* ------------------------------- models ------------------------------- */

api.get('/models', (req, res) => {
  const channelId = req.query.channel_id;
  const rows = channelId
    ? all('SELECT * FROM models WHERE channel_id = ? ORDER BY created_at', channelId)
    : all('SELECT * FROM models ORDER BY created_at');
  ok(res, rows.map((m: any) => ({ ...m, params: JSON.parse(m.params ?? '{}') })));
});

api.post('/models', (req, res) => {
  const b = body(req);
  const ch = get('SELECT * FROM channels WHERE id = ?', b.channel_id);
  if (!ch) return fail(res, 400, 'channel_id must reference an existing channel');
  if (!b.name?.trim()) return fail(res, 400, 'Model name is required');
  const id = uid();
  run(
    `INSERT INTO models (id, channel_id, name, file_name, capability, adapter, params, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, ch.id, b.name.trim(), b.file_name ?? null, b.capability ?? 'text-to-video',
    b.adapter ?? (ch.type === 'comfyui' ? 'comfy-video' : 'openai-image'),
    JSON.stringify({ ...adapterParamDefaults(b.adapter ?? ''), ...(b.params ?? {}) }),
    b.enabled === false ? 0 : 1, now(),
  );
  ok(res, get('SELECT * FROM models WHERE id = ?', id), 201);
});

api.patch('/models/:id', (req, res) => {
  const m = get('SELECT * FROM models WHERE id = ?', req.params.id);
  if (!m) return fail(res, 404, 'Model not found');
  const b = body(req);
  for (const key of ['name', 'file_name', 'capability', 'adapter'] as const) {
    if (b[key] !== undefined) run(`UPDATE models SET ${key} = ? WHERE id = ?`, b[key], m.id);
  }
  if (b.params !== undefined) run('UPDATE models SET params = ? WHERE id = ?', JSON.stringify(b.params), m.id);
  if (b.enabled !== undefined) run('UPDATE models SET enabled = ? WHERE id = ?', b.enabled ? 1 : 0, m.id);
  ok(res, get('SELECT * FROM models WHERE id = ?', m.id));
});

api.delete('/models/:id', (req, res) => {
  run('DELETE FROM models WHERE id = ?', req.params.id);
  ok(res, { deleted: true });
});

/* ------------------------------- routes ------------------------------- */

api.get('/routes', (req, res) => {
  const { project_id, segment_id } = req.query as Record<string, string | undefined>;
  let rows = all('SELECT * FROM routes ORDER BY created_at');
  if (project_id) rows = rows.filter((r: any) => r.project_id === project_id);
  if (segment_id) rows = rows.filter((r: any) => r.segment_id === segment_id);
  ok(res, rows);
});

api.post('/routes', (req, res) => {
  const b = body(req);
  if (!b.purpose) return fail(res, 400, 'purpose is required');
  const model = get('SELECT * FROM models WHERE id = ?', b.model_id);
  if (!model) return fail(res, 400, 'model_id must reference an existing model');
  if (b.segment_id) run('DELETE FROM routes WHERE segment_id = ? AND purpose = ?', b.segment_id, b.purpose);
  else if (b.project_id) run('DELETE FROM routes WHERE project_id = ? AND purpose = ? AND segment_id IS NULL', b.project_id, b.purpose);
  else return fail(res, 400, 'Either project_id or segment_id is required');
  const id = uid();
  run('INSERT INTO routes (id, project_id, segment_id, purpose, model_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    id, b.project_id ?? null, b.segment_id ?? null, b.purpose, model.id, now());
  ok(res, get('SELECT * FROM routes WHERE id = ?', id), 201);
});

api.delete('/routes/:id', (req, res) => {
  run('DELETE FROM routes WHERE id = ?', req.params.id);
  ok(res, { deleted: true });
});

/* -------------------------------- jobs -------------------------------- */

function resolveModel(segmentId: string, projectId: string | null, purpose: string, explicitModelId?: string): any | null {
  if (explicitModelId) return get('SELECT * FROM models WHERE id = ?', explicitModelId);
  const segRoute = get<any>('SELECT model_id FROM routes WHERE segment_id = ? AND purpose = ?', segmentId, purpose);
  if (segRoute) return get('SELECT * FROM models WHERE id = ?', segRoute.model_id);
  if (projectId) {
    const projRoute = get<any>(
      'SELECT model_id FROM routes WHERE project_id = ? AND segment_id IS NULL AND purpose = ?', projectId, purpose);
    if (projRoute) return get('SELECT * FROM models WHERE id = ?', projRoute.model_id);
  }
  return null;
}

/**
 * Push a media file into ComfyUI's input dir so a LoadImage node can
 * reference it by name. Throws on any failure — adapters that cannot run
 * without the frame (h3-fl2va) use this directly so the job fails loudly.
 */
async function uploadFrameToComfy(channel: any, mediaRelPath: string, role: string): Promise<string> {
  const abs = path.join(MEDIA_DIR, mediaRelPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`${role} file not found in the media library: ${mediaRelPath}`);
  }
  const form = new FormData();
  const data = fs.readFileSync(abs);
  form.append('image', new Blob([new Uint8Array(data)]), path.basename(mediaRelPath));
  form.append('overwrite', 'true');
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(`${channel.base_url.replace(/\/+$/, '')}/upload/image`, { method: 'POST', body: form });
  } catch (err: any) {
    throw new Error(`${role} upload to ComfyUI failed: ${err?.message ?? err}`);
  }
  if (!res.ok) throw new Error(`${role} upload to ComfyUI failed: HTTP ${res.status}`);
  const json: any = await res.json().catch(() => ({}));
  return json.name ?? path.basename(mediaRelPath);
}

async function tryUploadFirstFrame(channel: any, mediaRelPath: string): Promise<string | null> {
  // Best effort variant for adapters that can run without the frame.
  try {
    return await uploadFrameToComfy(channel, mediaRelPath, 'First frame');
  } catch {
    return null;
  }
}

api.post('/segments/:id/jobs', async (req, res) => {
  const seg = get<any>('SELECT * FROM segments WHERE id = ?', req.params.id);
  if (!seg) return fail(res, 404, 'Segment not found');
  const sb = get<any>('SELECT * FROM storyboards WHERE id = ?', seg.storyboard_id);
  const project = sb ? get<any>('SELECT * FROM projects WHERE id = ?', sb.project_id) : null;
  const b = body(req);
  const overrides = b.settings ?? {};

  // Label is a hard rule: an explicitly blank label is rejected; a missing
  // label gets the system default "project / storyboard-segment / type".
  let label: string;
  if (b.label !== undefined) {
    label = String(b.label).trim();
    if (!label) return fail(res, 400, 'Job label must not be empty');
  } else {
    const typeWord = (b.purpose ?? 'video') === 'image' ? 'image' : 'video';
    label = `${project?.short_name || project?.name || 'project'} / E${sb?.seq ?? 1}-${seg.seq} / ${typeWord}`;
  }

  const purpose: string = b.purpose ?? 'video';
  const model = resolveModel(seg.id, project?.id ?? null, purpose, b.model_id);
  if (!model) return fail(res, 400, 'No model selected and no route configured for this purpose');
  const channel = get<any>('SELECT * FROM channels WHERE id = ?', model.channel_id);
  if (!channel) return fail(res, 400, 'Model channel no longer exists');
  if (!channel.enabled || !model.enabled) return fail(res, 400, 'Channel or model is disabled');

  // h3-fl2va hard rule: FL2VA never runs without a first frame. The frame
  // source is the job override or the segment's stored frame (media-relative
  // path); the optional last frame follows the same convention.
  const isFl2va = model.adapter === 'h3-fl2va';
  const firstFrameRel: string | null = overrides.first_frame ?? seg.first_frame ?? null;
  const lastFrameRel: string | null = overrides.last_frame ?? seg.last_frame ?? null;
  if (isFl2va && !firstFrameRel) {
    return fail(res, 400, 'h3-fl2va requires a first frame: set one on the segment (or pass settings.first_frame)');
  }

  // h3-ref2va hard rule: Ref2VA identity comes entirely from its reference
  // images, so a job without any is rejected before creation — running
  // short-handed would produce a plausible-but-wrong person, worse than an
  // error. Order matters: index i in the array is <Picture i+1> in prompts.
  const isRef2va = model.adapter === 'h3-ref2va';
  const refImagesRel: string[] = overrides.ref_images !== undefined
    ? parseRefImages(overrides.ref_images)
    : parseRefImages(seg.ref_images);
  const refAudioRel: string | null = overrides.ref_audio !== undefined
    ? (overrides.ref_audio || null)
    : (seg.ref_audio ?? null);
  const refImageSize: string = overrides.ref_image_size ?? 'match';
  if (isRef2va) {
    if (refImagesRel.length === 0) {
      return fail(res, 400, 'h3-ref2va requires at least one reference image: set reference images on the segment (or pass settings.ref_images)');
    }
    if (refImagesRel.length > 9) {
      return fail(res, 400, `h3-ref2va accepts at most 9 reference images (got ${refImagesRel.length})`);
    }
    if (refImageSize !== 'match' && refImageSize !== 'max') {
      return fail(res, 400, `ref_image_size must be "match" or "max" (got "${refImageSize}")`);
    }
  }

  // Effective settings: segment values, then project defaults, then built-ins.
  const adjustments: string[] = [];
  const widthRaw = overrides.width ?? seg.width ?? project?.default_width ?? 736;
  const heightRaw = overrides.height ?? seg.height ?? project?.default_height ?? 1280;
  const w = snapTo32(Number(widthRaw));
  const h = snapTo32(Number(heightRaw));
  if (w.snapped) adjustments.push(`width ${widthRaw} -> ${w.value} (multiple of 32)`);
  if (h.snapped) adjustments.push(`height ${heightRaw} -> ${h.value} (multiple of 32)`);
  const framesRaw = overrides.frames ?? seg.frames ?? 124;
  const fr = purpose === 'image' ? { frames: 1, snapped: false } : snapFrames(Number(framesRaw));
  if (fr.snapped) adjustments.push(`frames ${framesRaw} -> ${fr.frames} (17k+5 grid)`);
  const seedRaw = overrides.seed ?? seg.seed ?? -1;
  // Fallback chain: job overrides -> segment values -> adapter defaults
  // (e.g. h3-image runs 6 steps / CFG 1) -> global built-ins.
  const ad = ADAPTER_DEFAULTS[model.adapter] ?? {};
  let modelParams: Record<string, any> = {};
  try { modelParams = JSON.parse(model.params ?? '{}'); } catch { modelParams = {}; }
  const settings: GenSettings = {
    width: w.value,
    height: h.value,
    frames: fr.frames,
    fps: overrides.fps ?? seg.fps ?? 24,
    steps: overrides.steps ?? seg.steps ?? ad.steps ?? 20,
    cfg: overrides.cfg ?? seg.cfg ?? ad.cfg ?? 7,
    seed: Number(seedRaw) < 0 ? Math.floor(Math.random() * 2 ** 31) : Number(seedRaw),
    sampler: overrides.sampler ?? seg.sampler ?? ad.sampler ?? 'euler',
    scheduler: overrides.scheduler ?? seg.scheduler ?? ad.scheduler ?? 'simple',
    prompt: overrides.prompt ?? seg.prompt ?? '',
    firstFrameName: null,
    refImageNames: [],
    refAudioName: null,
    refImageSize,
    seedreamLora: Boolean(overrides.seedream_lora ?? modelParams.seedream_lora ?? false),
  };
  const snapshot = {
    aspect: seg.aspect_override ?? project?.aspect ?? '9:16',
    width: settings.width, height: settings.height, frames: settings.frames, fps: settings.fps,
    steps: settings.steps, cfg: settings.cfg, seed: settings.seed,
    sampler: settings.sampler, scheduler: settings.scheduler,
    prompt: settings.prompt, purpose,
    adapter: model.adapter, seedream_lora: settings.seedreamLora ?? false,
    first_frame: firstFrameRel, last_frame: lastFrameRel,
    ref_images: isRef2va ? refImagesRel : undefined,
    ref_audio: isRef2va ? refAudioRel : undefined,
    ref_image_size: isRef2va ? refImageSize : undefined,
    model_id: model.id, model_name: model.name,
    expected_model: model.file_name ?? model.name,
    channel_id: channel.id, channel_name: channel.name,
    adjustments,
  };

  const jobId = uid();
  run(
    `INSERT INTO jobs (id, segment_id, label, channel_id, model_id, expected_model, snapshot, status, submitted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
    jobId, seg.id, label, channel.id, model.id, snapshot.expected_model, JSON.stringify(snapshot), now(),
  );

  // Material overrides stick to the segment: reference images / audio passed
  // per-job are the segment's materials, not trial parameters, so persist
  // them back — otherwise the detail view shows nothing and the next job
  // silently loses the reference audio. Numeric trial settings (steps,
  // seed, frames, ...) deliberately do NOT write back.
  if (isRef2va) {
    if (overrides.ref_images !== undefined) {
      run('UPDATE segments SET ref_images = ? WHERE id = ?', JSON.stringify(refImagesRel), seg.id);
    }
    if (overrides.ref_audio !== undefined) {
      run('UPDATE segments SET ref_audio = ? WHERE id = ?', refAudioRel, seg.id);
    }
  }

  try {
    if (channel.type === 'comfyui') {
      if (isFl2va) {
        // Strict uploads: any failure throws, the job is marked failed with
        // the reason — a frameless FL2VA run must never slip through.
        settings.firstFrameName = await uploadFrameToComfy(channel, firstFrameRel!, 'First frame');
        if (lastFrameRel) settings.lastFrameName = await uploadFrameToComfy(channel, lastFrameRel, 'Last frame');
        run('UPDATE jobs SET snapshot = ? WHERE id = ?',
          JSON.stringify({ ...snapshot, first_frame_name: settings.firstFrameName, last_frame_name: settings.lastFrameName ?? null }),
          jobId);
      } else if (isRef2va) {
        // Strict uploads, one by one, in slot order: any failure throws and
        // the job fails with the reason — a Ref2VA run missing a reference
        // image must never slip through (it would render the wrong person).
        // The reference audio rides the same /upload/image channel for now:
        // whether real ComfyUI accepts non-image files there is unverified
        // (ground-truth checklist #3) — if it refuses, the error surfaces
        // here verbatim instead of the audio being silently dropped.
        settings.refImageNames = [];
        for (let i = 0; i < refImagesRel.length; i++) {
          settings.refImageNames.push(await uploadFrameToComfy(channel, refImagesRel[i], `Reference image ${i + 1}`));
        }
        if (refAudioRel) {
          settings.refAudioName = await uploadFrameToComfy(channel, refAudioRel, 'Reference audio');
        }
        run('UPDATE jobs SET snapshot = ? WHERE id = ?',
          JSON.stringify({
            ...snapshot,
            ref_image_names: settings.refImageNames,
            ref_audio_name: settings.refAudioName ?? null,
          }),
          jobId);
      } else if (seg.first_frame) {
        settings.firstFrameName = await tryUploadFirstFrame(channel, seg.first_frame);
      }
      const workflow = buildComfyWorkflow(model.adapter, model.file_name ?? model.name, settings, `auteur_${jobId.slice(0, 8)}`);
      const submitted = await comfySubmit(channel.base_url, workflow);
      run('UPDATE jobs SET prompt_id = ?, queue_number = ? WHERE id = ?', submitted.prompt_id, submitted.number, jobId);
    } else {
      // OpenAI-compatible: run asynchronously, the job row tracks progress.
      run('UPDATE jobs SET status = ?, started_at = ? WHERE id = ?', 'running', now(), jobId);
      void (async () => {
        try {
          const result = await submitOpenAIImage(channel.base_url, channel.api_key, model.name, settings);
          const dir = path.join(MEDIA_DIR, 'takes', jobId);
          fs.mkdirSync(dir, { recursive: true });
          const relPath = path.posix.join('takes', jobId, result.fileName);
          fs.writeFileSync(path.join(MEDIA_DIR, relPath), result.buffer);
          run(
            `INSERT INTO takes (id, segment_id, job_id, file_path, file_name, kind, size, actual_model, verify_status, note, created_at)
             VALUES (?, ?, ?, ?, ?, 'image', ?, ?, 'unverified', 'model name reported by API, no embedded metadata', ?)`,
            uid(), seg.id, jobId, relPath, result.fileName, result.buffer.length, result.actualModel, now(),
          );
          run('UPDATE jobs SET status = ?, finished_at = ? WHERE id = ?', 'completed', now(), jobId);
        } catch (err: any) {
          run('UPDATE jobs SET status = ?, error = ?, finished_at = ? WHERE id = ?', 'failed', String(err?.message ?? err), now(), jobId);
        }
      })();
    }
  } catch (err: any) {
    run('UPDATE jobs SET status = ?, error = ?, finished_at = ? WHERE id = ?', 'failed', String(err?.message ?? err), now(), jobId);
    return fail(res, 502, `Submission failed: ${err?.message ?? err}`, { job_id: jobId });
  }

  const created = get<any>('SELECT * FROM jobs WHERE id = ?', jobId);
  ok(res, { ...created, snapshot: JSON.parse(created.snapshot ?? '{}') }, 201);
});

api.get('/jobs', (req, res) => {
  const { status, segment_id } = req.query as Record<string, string | undefined>;
  let sql = `SELECT j.*, s.title AS segment_title, s.seq AS segment_seq, sb.seq AS storyboard_seq,
                    p.name AS project_name
               FROM jobs j
               JOIN segments s ON s.id = j.segment_id
               JOIN storyboards sb ON sb.id = s.storyboard_id
               JOIN projects p ON p.id = sb.project_id`;
  const where: string[] = [];
  const params: any[] = [];
  if (status) { where.push('j.status = ?'); params.push(status); }
  if (segment_id) { where.push('j.segment_id = ?'); params.push(segment_id); }
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  sql += ' ORDER BY j.submitted_at DESC';
  ok(res, all(sql, ...params).map((j: any) => ({ ...j, snapshot: JSON.parse(j.snapshot ?? '{}') })));
});

api.get('/jobs/:id', (req, res) => {
  const job = get<any>('SELECT * FROM jobs WHERE id = ?', req.params.id);
  if (!job) return fail(res, 404, 'Job not found');
  ok(res, { ...job, snapshot: JSON.parse(job.snapshot ?? '{}') });
});

api.post('/jobs/:id/cancel', async (req, res) => {
  const job = get<any>('SELECT * FROM jobs WHERE id = ?', req.params.id);
  if (!job) return fail(res, 404, 'Job not found');
  if (job.status !== 'queued') return fail(res, 400, `Only queued jobs can be cancelled (current status: ${job.status}). Use stop for running jobs.`);
  const channel = job.channel_id ? get<any>('SELECT * FROM channels WHERE id = ?', job.channel_id) : null;
  if (channel?.type === 'comfyui' && job.prompt_id) {
    try { await comfyDeleteFromQueue(channel.base_url, job.prompt_id); } catch { /* local state still settles */ }
  }
  run('UPDATE jobs SET status = ?, finished_at = ? WHERE id = ?', 'cancelled', now(), job.id);
  ok(res, get('SELECT * FROM jobs WHERE id = ?', job.id));
});

api.post('/jobs/:id/stop', async (req, res) => {
  const job = get<any>('SELECT * FROM jobs WHERE id = ?', req.params.id);
  if (!job) return fail(res, 404, 'Job not found');
  if (job.status !== 'running') return fail(res, 400, `Only running jobs can be stopped (current status: ${job.status}). Use cancel for queued jobs.`);
  const channel = job.channel_id ? get<any>('SELECT * FROM channels WHERE id = ?', job.channel_id) : null;
  if (channel?.type === 'comfyui') {
    try { await comfyInterrupt(channel.base_url); } catch { /* poller reconciles */ }
  }
  // The poller resolves "stopping" to "stopped" against /queue + /history.
  run('UPDATE jobs SET status = ? WHERE id = ?', 'stopping', job.id);
  ok(res, get('SELECT * FROM jobs WHERE id = ?', job.id));
});

/* -------------------------------- takes ------------------------------- */

api.post('/takes/:id/select', (req, res) => {
  const take = get<any>('SELECT * FROM takes WHERE id = ?', req.params.id);
  if (!take) return fail(res, 404, 'Take not found');
  const force = body(req).force === true;
  if (take.verify_status !== 'verified' && !force) {
    return fail(res, 409, 'This take is not base-model verified; selecting it requires explicit confirmation', {
      needs_confirm: true, verify_status: take.verify_status,
    });
  }
  run('UPDATE segments SET selected_take_id = ?, updated_at = ? WHERE id = ?', take.id, now(), take.segment_id);
  ok(res, { selected_take_id: take.id });
});

api.delete('/takes/:id', (req, res) => {
  const take = get<any>('SELECT * FROM takes WHERE id = ?', req.params.id);
  if (!take) return fail(res, 404, 'Take not found');
  const seg = get<any>('SELECT * FROM segments WHERE id = ?', take.segment_id);
  const confirm = req.query.confirm === 'true' || body(req).confirm === true;
  if (seg?.selected_take_id === take.id && !confirm) {
    return fail(res, 409, 'This take is currently selected; deleting it requires confirm=true', { needs_confirm: true });
  }
  if (seg?.selected_take_id === take.id) {
    run('UPDATE segments SET selected_take_id = NULL WHERE id = ?', seg.id);
  }
  try { fs.rmSync(path.join(MEDIA_DIR, take.file_path), { force: true }); } catch { /* file may already be gone */ }
  run('DELETE FROM takes WHERE id = ?', take.id);
  ok(res, { deleted: true });
});

/* ------------------------------ settings ------------------------------ */

api.get('/settings', (_req, res) => {
  ok(res, { data_dir: DATA_DIR, media_dir: MEDIA_DIR });
});

api.get('/health', (_req, res) => {
  ok(res, { ok: true, service: 'auteur-server' });
});
