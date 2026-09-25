import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createApiServer, type ApiServer } from '../src/server.ts';

/**
 * Backup endpoints over HTTP (FR-22, NFR-09): export is an owner-only
 * octet-stream, restore verifies the passphrase before swapping the database,
 * and a wrong passphrase never destroys the current data.
 */

async function withServer(fn: (base: string, api: ApiServer) => Promise<void>): Promise<void> {
  const api = createApiServer({});
  await new Promise<void>((resolve) => api.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${api.port()}`;
  try {
    await fn(base, api);
  } finally {
    await api.close();
  }
}

interface Res {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function call(
  base: string,
  path: string,
  options: { method?: string; body?: unknown; acting?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (options.acting !== undefined) headers['x-acting-user'] = options.acting;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${path}`, {
    method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

async function bootstrap(base: string): Promise<void> {
  const res = await call(base, '/api/bootstrap', {
    body: { organizationName: 'Wilson Properties', landlordName: 'Wilson Ndiko', deviceName: 'Laptop', platform: 'WINDOWS' },
  });
  assert.equal(res.status, 200);
}

test('api: backup export → restore round trip over HTTP', async () => {
  await withServer(async (base) => {
    await bootstrap(base);
    const prop = await call(base, '/api/properties', { body: { name: 'Green View Apartments', town: 'Nairobi' } });
    await call(base, `/api/properties/${prop.body.property.id}/units`, { body: { label: 'A-11' } });

    // Export (owner by default) → octet-stream with a filename.
    const res = await fetch(`${base}/api/backup/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passphrase: 'nyumba-huru-2026' }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    assert.match(res.headers.get('content-disposition') ?? '', /^attachment; filename="kitabu-backup-/);
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.ok(bytes.length > 100);

    // The state reports the backup time (Settings screen).
    const state = await call(base, '/api/state');
    assert.equal(typeof state.body.lastBackupAt, 'string');

    // Restore onto the same server: org and data come back.
    const restored = await call(base, '/api/backup/restore', {
      body: { passphrase: 'nyumba-huru-2026', backupBase64: Buffer.from(bytes).toString('base64') },
    });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.bootstrapped, true);
    assert.equal(restored.body.org.name, 'Wilson Properties');
    const props = await call(base, '/api/properties');
    assert.equal(props.body.length, 1);
    assert.equal(props.body[0].name, 'Green View Apartments');
  });
});

test('api: backup wrong passphrase is a friendly 400, device untouched', async () => {
  await withServer(async (base) => {
    await bootstrap(base);
    const exportRes = await fetch(`${base}/api/backup/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passphrase: 'nyumba-huru-2026' }),
    });
    const bytes = new Uint8Array(await exportRes.arrayBuffer());

    const bad = await call(base, '/api/backup/restore', {
      body: { passphrase: 'not-the-passphrase', backupBase64: Buffer.from(bytes).toString('base64') },
    });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error.message, /passphrase does not match/i);

    // The device still has its organization — nothing was destroyed.
    const state = await call(base, '/api/state');
    assert.equal(state.body.bootstrapped, true);
    assert.equal(state.body.org.name, 'Wilson Properties');
  });
});

test('api: only the owner can export a backup; caretaker gets 403', async () => {
  await withServer(async (base, api) => {
    await bootstrap(base);
    const added = await call(base, '/api/users', { body: { fullName: 'Jane Caretaker', role: 'CARETAKER' } });
    const caretakerId = added.body.user.id as string;

    const res = await fetch(`${base}/api/backup/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-acting-user': caretakerId },
      body: JSON.stringify({ passphrase: 'nyumba-huru-2026' }),
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error: { message: string } };
    assert.match(body.error.message, /only an owner can export an encrypted backup/i);
    assert.ok(api.kitabu.isBootstrapped);
  });
});

test('api: a non-backup file upload is rejected before anything changes', async () => {
  await withServer(async (base) => {
    await bootstrap(base);
    const bad = await call(base, '/api/backup/restore', {
      body: { passphrase: 'nyumba-huru-2026', backupBase64: Buffer.from('not a backup').toString('base64') },
    });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error.message, /Kitabu backup/i);
    const state = await call(base, '/api/state');
    assert.equal(state.body.org.name, 'Wilson Properties');
  });
});
