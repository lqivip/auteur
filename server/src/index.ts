import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb } from './db.js';
import { api } from './api.js';
import { startPoller } from './poller.js';
import { DATA_DIR, MEDIA_DIR, PORT, HOST, ensureDirs } from './config.js';

initDb();
ensureDirs();

const app = express();
app.use(express.json({ limit: '32mb' }));

app.use('/api', api);

// Media files live under the data directory; express.static guards traversal.
app.use('/media', express.static(MEDIA_DIR));

// Serve the built front end when present (web/dist). The desktop shell
// points AUTEUR_WEB_DIST at the bundled copy; a plain checkout resolves
// ../../web/dist relative to this file. The env branch must stay lazy:
// inside the SEA sidecar import.meta.url is not a real file URL.
const webDist = process.env.AUTEUR_WEB_DIST
  ? path.resolve(process.env.AUTEUR_WEB_DIST)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^(?!\/api|\/media).*/, (_req, res) => {
    res.sendFile(path.join(webDist, 'index.html'));
  });
}

startPoller();

app.listen(PORT, HOST, () => {
  console.log(`AUTEUR server listening on http://${HOST}:${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
});
