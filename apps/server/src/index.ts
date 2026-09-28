import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db/index.js';
import { buildRouter, errorHandler } from './routes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.KITABU_DB || join(__dirname, '..', 'data', 'kitabu.db');
const PORT = Number(process.env.PORT || 4000);

const db = openDb(DB_PATH);
const app = express();
app.use(express.json({ limit: '2mb' }));

app.use('/api', buildRouter(db));

// serve the built web UI when present (production/desktop packaging mode)
const webDist = join(__dirname, '..', '..', 'web', 'dist');
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(join(webDist, 'index.html')));
}

app.use(errorHandler);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[kitabu] local core service on http://0.0.0.0:${PORT} (db: ${DB_PATH})`);
});
