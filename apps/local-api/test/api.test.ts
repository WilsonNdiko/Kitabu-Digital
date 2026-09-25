import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createApiServer, type ApiServer } from '../src/server.ts';

/**
 * The local API is a thin router over the core — these tests prove the contract
 * the app shells rely on: JSON in/out, friendly errors with correct statuses,
 * role enforcement via the X-Acting-User header, and the full money flow.
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

test('api: fresh device reports unbootstrapped; bootstrap opens the books', async () => {
  await withServer(async (base, api) => {
    const fresh = await call(base, '/api/state');
    assert.equal(fresh.status, 200);
    assert.equal(fresh.body.bootstrapped, false);

    const done = await call(base, '/api/bootstrap', {
      body: { organizationName: 'Wilson Properties', landlordName: 'Wilson Ndiko', deviceName: 'Laptop', platform: 'WINDOWS' },
    });
    assert.equal(done.status, 200);
    assert.equal(done.body.bootstrapped, true);
    assert.equal(done.body.org.name, 'Wilson Properties');
    assert.equal(typeof done.body.actingUserId, 'string');
    assert.ok(api.kitabu.isBootstrapped);
  });
});

test('api: the landlord flow — property, tenant, charge, payment, receipt, dashboard', async () => {
  await withServer(async (base) => {
    await call(base, '/api/bootstrap', {
      body: { organizationName: 'Wilson Properties', landlordName: 'Wilson Ndiko', deviceName: 'Laptop', platform: 'WINDOWS' },
    });

    const prop = await call(base, '/api/properties', { body: { name: 'Green View Apartments', town: 'Nairobi' } });
    assert.equal(prop.status, 200);
    const unit = await call(base, `/api/properties/${prop.body.property.id}/units`, { body: { label: 'A-11' } });
    assert.equal(unit.status, 200);

    const tenant = await call(base, '/api/tenants', { body: { fullName: 'John Kamau', phone: '0712345678' } });
    assert.equal(tenant.status, 200);
    const tenancy = await call(base, `/api/tenants/${tenant.body.tenant.id}/tenancy`, {
      body: { unitId: unit.body.unit.id, rentMinor: 1_200_000, startDate: '2026-09-01' },
    });
    assert.equal(tenancy.status, 200);

    const month = new Date().toISOString().slice(0, 7);
    const charges = await call(base, '/api/ledger/generate-charges', { body: { month } });
    assert.equal(charges.status, 200);
    assert.equal(charges.body.created, 1);
    const again = await call(base, '/api/ledger/generate-charges', { body: { month } });
    assert.equal(again.body.created, 0); // idempotent

    const payment = await call(base, '/api/payments', {
      body: { tenancyId: tenancy.body.tenancy.id, amountMinor: 1_200_000, method: 'CASH', paidAt: '2026-09-06' },
    });
    assert.equal(payment.status, 200);
    assert.equal(payment.body.payment.status, 'VERIFIED'); // owner cash counts on the spot
    assert.equal(payment.body.payment.tenantName, 'John Kamau');

    const receipt = await call(base, '/api/receipts', { body: { paymentId: payment.body.payment.id } });
    assert.equal(receipt.status, 200);
    assert.equal(receipt.body.receipt.receipt_no, 'R-000001');
    assert.ok(receipt.body.snapshot.amountWords.startsWith('Kenya Shillings'));

    const detail = await call(base, `/api/receipts/${receipt.body.receipt.id}`);
    assert.equal(detail.body.integrity.ok, true);
    assert.equal(detail.body.integrity.signatureValid, true);

    const dash = await call(base, '/api/dashboard');
    assert.equal(dash.body.totals.units, 1);
    assert.equal(dash.body.collection.expectedMinor, 1_200_000);
    assert.equal(dash.body.collection.collectedMinor, 1_200_000);
    assert.equal(dash.body.arrearsTotalMinor, 0);
    assert.equal(dash.body.monthOverview[0].tenantName, 'John Kamau');

    const tenantDetail = await call(base, `/api/tenants/${tenant.body.tenant.id}`);
    assert.equal(tenantDetail.body.active.balanceMinor, 0);
    assert.ok(tenantDetail.body.active.statement.entries.length >= 2);
  });
});

test('api: roles travel on the header — caretaker records, cannot verify or rule', async () => {
  await withServer(async (base) => {
    const boot = await call(base, '/api/bootstrap', {
      body: { organizationName: 'Wilson Properties', landlordName: 'Wilson', deviceName: 'Laptop', platform: 'WINDOWS' },
    });
    const owner = boot.body.actingUserId as string;
    const prop = await call(base, '/api/properties', { body: { name: 'Green View' } });
    const unit = await call(base, `/api/properties/${prop.body.property.id}/units`, { body: { label: 'A-11' } });
    const tenant = await call(base, '/api/tenants', { body: { fullName: 'John Kamau' } });
    const tenancy = await call(base, `/api/tenants/${tenant.body.tenant.id}/tenancy`, {
      body: { unitId: unit.body.unit.id, rentMinor: 1_000_000, startDate: '2026-09-01' },
    });

    const jane = await call(base, '/api/users', { body: { fullName: 'Jane Njeri', role: 'CARETAKER' } });
    const janeId = jane.body.user.id as string;

    // Jane can register a tenant…
    const okTenant = await call(base, '/api/tenants', { body: { fullName: 'Mary Wanjiku' }, acting: janeId });
    assert.equal(okTenant.status, 200);

    // …but not create properties, place tenants, or generate charges.
    assert.equal((await call(base, '/api/properties', { body: { name: 'Sneaky' }, acting: janeId })).status, 403);
    assert.equal((await call(base, `/api/tenants/${okTenant.body.tenant.id}/tenancy`, {
      body: { unitId: unit.body.unit.id, rentMinor: 1_000_000, startDate: '2026-09-01' }, acting: janeId,
    })).status, 403);
    assert.equal((await call(base, '/api/ledger/generate-charges', { body: { month: '2026-09' }, acting: janeId })).status, 403);

    // Jane records an M-Pesa code — it waits for the owner.
    const month = new Date().toISOString().slice(0, 7);
    await call(base, '/api/ledger/generate-charges', { body: { month } });
    const payment = await call(base, '/api/payments', {
      body: { tenancyId: tenancy.body.tenancy.id, amountMinor: 1_000_000, method: 'MPESA', paidAt: '2026-09-06', reference: 'QGH7XJ2M9L' },
      acting: janeId,
    });
    assert.equal(payment.body.payment.status, 'PENDING');

    const cannotVerify = await call(base, `/api/payments/${payment.body.payment.id}/verify`, { body: {}, acting: janeId });
    assert.equal(cannotVerify.status, 403);
    assert.match(cannotVerify.body.error.message, /Only an owner/i);

    const verified = await call(base, `/api/payments/${payment.body.payment.id}/verify`, { body: { note: 'Checked' }, acting: owner });
    assert.equal(verified.status, 200);
    assert.equal(verified.body.payment.status, 'VERIFIED');
  });
});

test('api: duplicate M-Pesa codes are refused with a friendly message — never double money', async () => {
  await withServer(async (base) => {
    await call(base, '/api/bootstrap', {
      body: { organizationName: 'Wilson Properties', landlordName: 'Wilson', deviceName: 'Laptop', platform: 'WINDOWS' },
    });
    const prop = await call(base, '/api/properties', { body: { name: 'Green View' } });
    const u1 = await call(base, `/api/properties/${prop.body.property.id}/units`, { body: { label: 'A-11' } });
    const u2 = await call(base, `/api/properties/${prop.body.property.id}/units`, { body: { label: 'A-12' } });
    const t1 = await call(base, '/api/tenants', { body: { fullName: 'John Kamau' } });
    const t2 = await call(base, '/api/tenants', { body: { fullName: 'Mary Wanjiku' } });
    const n1 = await call(base, `/api/tenants/${t1.body.tenant.id}/tenancy`, { body: { unitId: u1.body.unit.id, rentMinor: 1_000_000, startDate: '2026-09-01' } });
    const n2 = await call(base, `/api/tenants/${t2.body.tenant.id}/tenancy`, { body: { unitId: u2.body.unit.id, rentMinor: 1_000_000, startDate: '2026-09-01' } });

    const first = await call(base, '/api/payments', {
      body: { tenancyId: n1.body.tenancy.id, amountMinor: 1_000_000, method: 'MPESA', paidAt: '2026-09-06', reference: 'QGH7XJ2M9L' },
    });
    assert.equal(first.status, 200);

    const dup = await call(base, '/api/payments', {
      body: { tenancyId: n2.body.tenancy.id, amountMinor: 1_000_000, method: 'MPESA', paidAt: '2026-09-06', reference: 'QGH7XJ2M9L' },
    });
    assert.equal(dup.status, 409);
    assert.match(dup.body.error.message, /already been recorded/i);
  });
});

test('api: errors map to friendly JSON — 404 for unknown screens, 400 for bad bodies', async () => {
  await withServer(async (base) => {
    const boot = await call(base, '/api/bootstrap', {
      body: { organizationName: 'Wilson Properties', landlordName: 'Wilson', deviceName: 'Laptop', platform: 'WINDOWS' },
    });
    assert.equal(boot.status, 200);

    assert.equal((await call(base, '/api/nope')).status, 404);

    const bad = await fetch(`${base}/api/properties`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json{{',
    });
    assert.equal(bad.status, 400);
    const payload = await bad.json() as { error: { message: string } };
    assert.ok(payload.error.message.length > 0);

    const empty = await call(base, '/api/properties', { body: { name: '   ' } });
    assert.equal(empty.status, 400);
    assert.match(empty.body.error.message, /name/i);
  });
});

test('api: demo reset wipes the device and returns to setup', async () => {
  await withServer(async (base, api) => {
    await call(base, '/api/bootstrap', {
      body: { organizationName: 'Wilson Properties', landlordName: 'Wilson', deviceName: 'Laptop', platform: 'WINDOWS' },
    });
    assert.equal((await call(base, '/api/state')).body.bootstrapped, true);

    const reset = await call(base, '/api/reset', { body: {} });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.bootstrapped, false);
    assert.equal(api.kitabu.isBootstrapped, false);
  });
});
