import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { DB_PATH, ensureDirs } from './config.js';

// Must run before opening the DB: on a fresh data dir the folder does not
// exist yet, and node:sqlite will not create parent directories.
ensureDirs();

export const db = new DatabaseSync(DB_PATH);

export function uid(): string {
  return crypto.randomUUID();
}

export function now(): string {
  return new Date().toISOString();
}

export function initDb(): void {
  ensureDirs();
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      short_name TEXT NOT NULL DEFAULT '',
      aspect TEXT NOT NULL DEFAULT '9:16',
      aspect_custom TEXT,
      default_width INTEGER NOT NULL DEFAULT 736,
      default_height INTEGER NOT NULL DEFAULT 1280,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS storyboards (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL DEFAULT 1,
      title TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      sort INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS segments (
      id TEXT PRIMARY KEY,
      storyboard_id TEXT NOT NULL REFERENCES storyboards(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL DEFAULT 1,
      title TEXT NOT NULL DEFAULT '',
      dialogue TEXT NOT NULL DEFAULT '',
      prompt TEXT NOT NULL DEFAULT '',
      first_frame TEXT,
      last_frame TEXT,
      ref_images TEXT,
      ref_audio TEXT,
      aspect_override TEXT,
      width INTEGER,
      height INTEGER,
      frames INTEGER,
      fps INTEGER NOT NULL DEFAULT 24,
      steps INTEGER,
      cfg REAL,
      seed INTEGER,
      sampler TEXT,
      scheduler TEXT,
      selected_take_id TEXT,
      sort INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS characters (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS character_images (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      version TEXT NOT NULL DEFAULT '',
      usage TEXT NOT NULL DEFAULT '',
      is_current INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('comfyui', 'openai-compatible')),
      base_url TEXT NOT NULL,
      api_key TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      model_files TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      file_name TEXT,
      capability TEXT NOT NULL DEFAULT 'text-to-video',
      adapter TEXT NOT NULL DEFAULT 'comfy-video',
      params TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS routes (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      segment_id TEXT REFERENCES segments(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL,
      model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      channel_id TEXT,
      model_id TEXT,
      expected_model TEXT,
      snapshot TEXT NOT NULL DEFAULT '{}',
      prompt_id TEXT,
      queue_number INTEGER,
      status TEXT NOT NULL DEFAULT 'queued',
      error TEXT,
      submitted_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS takes (
      id TEXT PRIMARY KEY,
      segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
      job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
      file_path TEXT NOT NULL,
      file_name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'image',
      size INTEGER NOT NULL DEFAULT 0,
      actual_model TEXT,
      verify_status TEXT NOT NULL DEFAULT 'unverified',
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  // Migrations for databases created before a column existed
  // (CREATE TABLE IF NOT EXISTS never alters an existing table).
  const segmentCols = db.prepare('PRAGMA table_info(segments)').all() as Array<{ name: string }>;
  if (!segmentCols.some((c) => c.name === 'last_frame')) {
    db.exec('ALTER TABLE segments ADD COLUMN last_frame TEXT');
  }
  // h3-ref2va material slots: ref_images is a JSON array of media-relative
  // paths (order = <Picture N> numbering), ref_audio one media-relative path.
  if (!segmentCols.some((c) => c.name === 'ref_images')) {
    db.exec('ALTER TABLE segments ADD COLUMN ref_images TEXT');
  }
  if (!segmentCols.some((c) => c.name === 'ref_audio')) {
    db.exec('ALTER TABLE segments ADD COLUMN ref_audio TEXT');
  }
}

/** Row helpers with loose typing: the API layer shapes responses. */
export function all<T = any>(sql: string, ...params: any[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}
export function get<T = any>(sql: string, ...params: any[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}
export function run(sql: string, ...params: any[]): void {
  db.prepare(sql).run(...params);
}
