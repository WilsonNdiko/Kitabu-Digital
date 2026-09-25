/**
 * Kitabu local API — entrypoint.
 *
 * Env:
 *   PORT          HTTP port (default 8787; bound to 127.0.0.1 — the UI reaches it
 *                 through the dev-server proxy or is served by this process itself)
 *   KITABU_DB     SQLite file path (default ./data/kitabu.db)
 *   KITABU_SEED   '0' disables demo seeding of a fresh database
 *   KITABU_STATIC directory of the built web app to serve (single-process demo)
 */

import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApiServer } from './server.ts';

const port = Number(process.env.PORT ?? '8787');
const here = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.KITABU_DB ?? join(here, '..', 'data', 'kitabu.db');
const staticDir = process.env.KITABU_STATIC;
const seed = process.env.KITABU_SEED !== '0';

if (staticDir !== undefined && !existsSync(staticDir)) {
  console.error(`[kitabu-api] static directory not found: ${staticDir}`);
  process.exit(1);
}

mkdirSync(dirname(dbPath), { recursive: true });

const api = createApiServer({ dbPath, seedDemo: seed, staticDir });
api.server.listen(port, '127.0.0.1', () => {
  console.log(`[kitabu-api] listening on http://127.0.0.1:${port} (db: ${dbPath}${seed ? ', demo seed on' : ''})`);
});
