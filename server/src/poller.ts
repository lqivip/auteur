import fs from 'node:fs';
import path from 'node:path';
import { all, get, run, uid, now } from './db.js';
import { MEDIA_DIR } from './config.js';
import { comfyQueue, comfyHistory, comfyViewFile, type ComfyHistoryEntry, type ComfyOutputFile } from './comfy.js';
import { extractBaseModel } from './pngmeta.js';

/**
 * Background reconciler: keeps local job rows in sync with ComfyUI.
 * - queued/running transitions come from GET /queue;
 * - completion comes from GET /history/{prompt_id}: outputs are downloaded,
 *   registered as takes, and the embedded base model is read back and
 *   compared with the job's expected model (the phase-1 hard rule);
 * - jobs in "stopping" are resolved to "stopped" once ComfyUI no longer
 *   reports them, so nothing can stay "running" forever.
 */

interface JobRow {
  id: string;
  segment_id: string;
  prompt_id: string | null;
  channel_id: string | null;
  expected_model: string | null;
  status: string;
  started_at: string | null;
}

async function finalize(job: JobRow, entry: ComfyHistoryEntry): Promise<void> {
  const files: ComfyOutputFile[] = [];
  for (const output of Object.values(entry.outputs ?? {})) {
    for (const f of output.images ?? []) files.push(f);
    for (const f of output.gifs ?? []) files.push({ ...f });
    for (const f of output.videos ?? []) files.push({ ...f });
  }
  const channel = get<any>('SELECT * FROM channels WHERE id = ?', job.channel_id);
  let actualModel: string | null = null;
  for (const file of files) {
    let buffer: Buffer | null = null;
    if (channel) {
      try { buffer = await comfyViewFile(channel.base_url, file); } catch { buffer = null; }
    }
    const dir = path.join(MEDIA_DIR, 'takes', job.id);
    fs.mkdirSync(dir, { recursive: true });
    const relPath = path.posix.join('takes', job.id, file.filename);
    if (buffer) fs.writeFileSync(path.join(MEDIA_DIR, relPath), buffer);
    const model = buffer ? extractBaseModel(buffer, file.filename) : null;
    if (model && !actualModel) actualModel = model;
    const lower = file.filename.toLowerCase();
    const kind = /\.(mp4|webm|mov|gif)$/.test(lower) ? 'video' : 'image';
    run(
      `INSERT INTO takes (id, segment_id, job_id, file_path, file_name, kind, size, actual_model, verify_status, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unverified', '', ?)`,
      uid(), job.segment_id, job.id, relPath, file.filename, kind, buffer?.length ?? 0, model, now(),
    );
  }
  const verify = !job.expected_model
    ? 'unverified'
    : actualModel === null
      ? 'unverified'
      : actualModel === job.expected_model
        ? 'verified'
        : 'mismatch';
  if (files.length > 0) {
    run('UPDATE takes SET verify_status = ? WHERE job_id = ?', verify, job.id);
  }
  run('UPDATE jobs SET status = ?, finished_at = ? WHERE id = ?', 'completed', now(), job.id);
}

async function tickJob(job: JobRow): Promise<void> {
  if (!job.prompt_id || !job.channel_id) return;
  const channel = get<any>('SELECT * FROM channels WHERE id = ?', job.channel_id);
  if (!channel || channel.type !== 'comfyui') return;

  const queue = await comfyQueue(channel.base_url);
  const isRunning = queue.running.includes(job.prompt_id);
  const isPending = queue.pending.includes(job.prompt_id);

  if (job.status === 'queued' && isRunning) {
    run('UPDATE jobs SET status = ?, started_at = ? WHERE id = ?', 'running', now(), job.id);
    job.status = 'running';
  }

  const entry = await comfyHistory(channel.base_url, job.prompt_id);
  if (entry) {
    if (entry.status?.completed) {
      await finalize(job, entry);
      return;
    }
    if (entry.status?.status_str === 'error') {
      const message = JSON.stringify(entry.status.messages ?? []).slice(0, 500);
      run('UPDATE jobs SET status = ?, error = ?, finished_at = ? WHERE id = ?', 'failed', message, now(), job.id);
      return;
    }
    if (job.status === 'stopping') {
      run('UPDATE jobs SET status = ?, finished_at = ? WHERE id = ?', 'stopped', now(), job.id);
      return;
    }
  }

  if (job.status === 'stopping' && !isRunning && !isPending) {
    run('UPDATE jobs SET status = ?, finished_at = ? WHERE id = ?', 'stopped', now(), job.id);
    return;
  }
  // A job we have seen running that vanished from the queue with no history
  // entry was interrupted outside our control: resolve it, never leave it
  // stuck in "running".
  if (job.status === 'running' && !isRunning && !isPending && !entry) {
    const startedAt = job.started_at ? Date.parse(job.started_at) : 0;
    if (Date.now() - startedAt > 5000) {
      run('UPDATE jobs SET status = ?, finished_at = ? WHERE id = ?', 'stopped', now(), job.id);
    }
  }
}

export function startPoller(intervalMs = 1500): NodeJS.Timeout {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const jobs = all<JobRow>(
        `SELECT * FROM jobs WHERE status IN ('queued', 'running', 'stopping') AND prompt_id IS NOT NULL`,
      );
      for (const job of jobs) {
        try { await tickJob(job); } catch { /* ComfyUI offline etc: retry next tick */ }
      }
    } finally {
      busy = false;
    }
  }, intervalMs);
  timer.unref();
  return timer;
}
