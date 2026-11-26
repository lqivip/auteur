import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Data directory resolution.
 * - AUTEUR_DATA_DIR env var always wins (used by dev / smoke tests).
 * - Otherwise the OS application-data area is used, never the install dir:
 *   Windows %APPDATA%\Auteur, macOS ~/Library/Application Support/Auteur,
 *   Linux $XDG_DATA_HOME/auteur or ~/.local/share/auteur.
 */
export function resolveDataDir(): string {
  const fromEnv = process.env.AUTEUR_DATA_DIR;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv);
  const home = os.homedir();
  switch (process.platform) {
    case 'win32': {
      const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
      return path.join(appData, 'Auteur');
    }
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Auteur');
    default: {
      const xdg = process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share');
      return path.join(xdg, 'auteur');
    }
  }
}

export const DATA_DIR = resolveDataDir();
export const MEDIA_DIR = path.join(DATA_DIR, 'media');
export const DB_PATH = path.join(DATA_DIR, 'auteur.db');
export const PORT = Number(process.env.AUTEUR_PORT ?? 4377);
export const HOST = process.env.AUTEUR_HOST ?? '127.0.0.1';

export function ensureDirs(): void {
  for (const dir of [DATA_DIR, MEDIA_DIR, path.join(MEDIA_DIR, 'uploads'), path.join(MEDIA_DIR, 'takes')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
