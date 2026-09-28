import { Router, type Request, type Response, type NextFunction } from 'express';
import { AppError, type DB } from './db/index.js';
import { getCtx, runSetup } from './services/setup.js';
import { addUnits, createProperty, createTenant, endTenancy, moveIn } from './services/portfolio.js';
import { issueReceipt, recordPayment, rejectPayment, reversePayment, tenancyBalance, verifyPayment, ensureCharges } from './services/finance.js';
import {
  arrears, dashboard, getReceipt, listAudit, listPayments, listProperties,
  listReceipts, listTenants, propertyDetail, search, syncStatus, tenantDetail,
} from './services/queries.js';
import { EXPENSE_CATEGORIES, createExpense, createMaintenance, listExpenses, listMaintenance, updateMaintenanceStatus } from './services/operations.js';
import { collectionReport, expenseReport, occupancyReport } from './services/reports.js';
import { seedDemo } from './seed.js';
import { getChangesSince, getPeerCursor, assertDeviceAllowed } from './sync/engine.js';
import {
  applyJoinBundle, createPairing, getSyncKey, handleJoin, httpTransport,
  localAddresses, performSync, receivePush,
} from './sync/service.js';
import { audit, getSetting, nowIso, updateRow } from './db/index.js';

export function buildRouter(db: DB): Router {
  const r = Router();
  const port = Number(process.env.PORT || 4000);

  const withCtx = (fn: (ctx: NonNullable<ReturnType<typeof getCtx>>, req: Request, res: Response) => unknown) =>
    (req: Request, res: Response, next: NextFunction) => {
      try {
        const ctx = getCtx(db);
        if (!ctx) throw new AppError('Kitabu is not set up on this device yet.', 409);
        Promise.resolve(fn(ctx, req, res)).catch(next);
      } catch (e) { next(e); }
    };

  // ---- bootstrap & onboarding ----
  r.get('/bootstrap', (req, res) => {
    const ctx = getCtx(db);
    if (!ctx) return res.json({ initialized: false });
    const org = db.prepare('SELECT id, name, terminology FROM organizations WHERE id = ?').get(ctx.orgId);
    const user = db.prepare('SELECT id, full_name, role FROM users WHERE id = ?').get(ctx.userId);
    res.json({ initialized: true, org, user, sync: syncStatus(ctx) });
  });

  r.post('/setup', (req, res) => {
    const out = runSetup(db, req.body);
    res.json(out);
  });

  r.post('/setup/demo', (req, res) => {
    const out = seedDemo(db);
    res.json(out);
  });

  // ---- dashboard / arrears / search / sync / audit ----
  r.get('/dashboard', withCtx((ctx, _q, res) => res.json(dashboard(ctx))));
  r.get('/arrears', withCtx((ctx, req, res) =>
    res.json(arrears(ctx, { propertyId: req.query.propertyId as string | undefined, period: req.query.period as string | undefined }))));
  r.get('/search', withCtx((ctx, req, res) => res.json(search(ctx, String(req.query.q ?? '')))));
  r.get('/sync/status', withCtx((ctx, _q, res) => res.json({ ...syncStatus(ctx), addresses: localAddresses(port) })));
  r.get('/audit', withCtx((ctx, _q, res) => res.json(listAudit(ctx))));

  // ---- properties ----
  r.get('/properties', withCtx((ctx, _q, res) => res.json(listProperties(ctx))));
  r.post('/properties', withCtx((ctx, req, res) => res.json(createProperty(ctx, req.body))));
  r.get('/properties/:id', withCtx((ctx, req, res) => res.json(propertyDetail(ctx, req.params.id!))));
  r.post('/properties/:id/units', withCtx((ctx, req, res) => res.json(addUnits(ctx, req.params.id!, req.body.units))));

  // ---- tenants & tenancies ----
  r.get('/tenants', withCtx((ctx, req, res) => res.json(listTenants(ctx, req.query.q as string | undefined))));
  r.post('/tenants', withCtx((ctx, req, res) => res.json(createTenant(ctx, req.body))));
  r.get('/tenants/:id', withCtx((ctx, req, res) => {
    const d = tenantDetail(ctx, req.params.id!);
    if (!d) throw new AppError('Tenant not found.', 404);
    res.json(d);
  }));
  r.post('/tenants/:id/move-in', withCtx((ctx, req, res) => res.json(moveIn(ctx, req.params.id!, req.body))));
  r.post('/tenancies/:id/end', withCtx((ctx, req, res) => {
    endTenancy(ctx, req.params.id!, req.body.endDate);
    res.json({ ok: true });
  }));
  r.get('/tenancies/:id/balance', withCtx((ctx, req, res) => {
    ensureCharges(ctx);
    res.json({ balanceMinor: tenancyBalance(ctx, req.params.id!) });
  }));

  // ---- payments (recorded, never processed) ----
  r.get('/payments', withCtx((ctx, req, res) => res.json(listPayments(ctx, req.query.status as string | undefined))));
  r.post('/payments', withCtx((ctx, req, res) => {
    const out = recordPayment(ctx, req.body);
    // auto-issue the receipt when the payment is verified at entry
    let receipt: { id: string; receiptNo?: string } | null = null;
    if (out.status === 'VERIFIED') receipt = issueReceipt(ctx, out.id);
    res.json({ ...out, receipt });
  }));
  r.post('/payments/:id/verify', withCtx((ctx, req, res) => {
    verifyPayment(ctx, req.params.id!);
    const receipt = issueReceipt(ctx, req.params.id!);
    res.json({ ok: true, receipt });
  }));
  r.post('/payments/:id/reject', withCtx((ctx, req, res) => {
    rejectPayment(ctx, req.params.id!, req.body.reason);
    res.json({ ok: true });
  }));
  r.post('/payments/:id/reverse', withCtx((ctx, req, res) => {
    reversePayment(ctx, req.params.id!, req.body.reason);
    res.json({ ok: true });
  }));

  // ---- receipts ----
  r.get('/receipts', withCtx((ctx, _q, res) => res.json(listReceipts(ctx))));
  r.get('/receipts/:id', withCtx((ctx, req, res) => {
    const rec = getReceipt(ctx, req.params.id!);
    if (!rec) throw new AppError('Receipt not found.', 404);
    res.json(rec);
  }));

  // ---- reports ----
  r.get('/reports/collection', withCtx((ctx, req, res) => res.json(collectionReport(ctx, req.query.period as string | undefined))));
  r.get('/reports/expenses', withCtx((ctx, req, res) => res.json(expenseReport(ctx, req.query.from as string | undefined, req.query.to as string | undefined))));
  r.get('/reports/occupancy', withCtx((ctx, _q, res) => res.json(occupancyReport(ctx))));

  // ============================ SYNC ============================
  // -- peer-facing endpoints (device-authenticated; used by OTHER devices) --
  const requireSyncAuth = (req: Request, _res: Response, next: NextFunction) => {
    try {
      const key = req.header('X-Kitabu-Key');
      const deviceId = req.header('X-Kitabu-Device');
      if (!key || key !== getSetting(db, 'sync_key')) throw new AppError('This device is not authorized to sync.', 403);
      if (!deviceId) throw new AppError('Missing device identity.', 403);
      assertDeviceAllowed(db, deviceId);
      (req as any).peerDeviceId = deviceId;
      next();
    } catch (e) { next(e); }
  };

  r.post('/sync/join', (req, res) => {
    // authenticated by the one-time pairing code instead of a device identity
    res.json(handleJoin(db, req.body));
  });
  r.get('/sync/hello', requireSyncAuth, withCtx((ctx, req, res) => {
    const dev = db.prepare('SELECT name FROM devices WHERE id = ?').get(ctx.deviceId) as any;
    res.json({
      deviceId: ctx.deviceId,
      deviceName: dev?.name ?? 'This device',
      orgId: ctx.orgId,
      cursorForYou: getPeerCursor(db, (req as any).peerDeviceId),
    });
  }));
  r.get('/sync/changes', requireSyncAuth, (req, res) => {
    const after = Number(req.query.after || 0);
    const limit = Math.min(Number(req.query.limit || 500), 500);
    res.json({ changes: getChangesSince(db, after, limit) });
  });
  r.post('/sync/apply', requireSyncAuth, (req, res) => {
    res.json(receivePush(db, (req as any).peerDeviceId, req.body.changes ?? []));
  });

  // -- local UI endpoints (this device's own user) --
  r.post('/sync/pairing', withCtx((ctx, _q, res) => res.json(createPairing(ctx, port))));
  r.post('/sync/pair-with', (req, res, next) => {
    // runs on a FRESH device during onboarding: join the landlord's Kitabu
    (async () => {
      const { address, code, deviceName } = req.body;
      if (!address?.trim()) throw new AppError('Enter the main device\u2019s address, e.g. 192.168.0.12:4000.');
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10000);
      let bundle: any;
      try {
        const resp = await fetch(`http://${String(address).replace(/^https?:\/\//, '')}/api/sync/join`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, deviceName: deviceName || 'New device', platform: process.platform }),
          signal: ctrl.signal,
        });
        const body: any = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new AppError(body.error || 'The main device refused the pairing.');
        bundle = body;
      } catch (e: any) {
        if (e instanceof AppError) throw e;
        throw new AppError('Could not reach the main device. Both devices must be on the same Wi-Fi or hotspot, with Kitabu open.', 502);
      } finally { clearTimeout(t); }
      res.json(applyJoinBundle(db, bundle, String(address)));
    })().catch(next);
  });
  r.post('/sync/now', withCtx(async (ctx, req, res) => {
    const peers = db.prepare(
      `SELECT sp.device_id, sp.peer_address, d.name FROM sync_peers sp
         LEFT JOIN devices d ON d.id = sp.device_id
        WHERE sp.peer_address IS NOT NULL ${req.body?.peerDeviceId ? 'AND sp.device_id = ?' : ''}`,
    ).all(...(req.body?.peerDeviceId ? [req.body.peerDeviceId] : [])) as any[];
    if (!peers.length) throw new AppError('No paired device with a known address. Start the sync from the other device, or pair a device first.');
    const results = [];
    for (const p of peers) {
      const transport = httpTransport(p.peer_address, ctx.deviceId, getSyncKey(db));
      results.push({ peer: p.name ?? p.device_id, ...(await performSync(ctx, transport, p.peer_address)) });
    }
    res.json({ results });
  }));
  r.get('/devices', withCtx((ctx, _q, res) => {
    res.json(db.prepare('SELECT id, name, platform, device_code, status, paired_at, last_sync_at FROM devices WHERE org_id = ? ORDER BY paired_at').all(ctx.orgId));
  }));
  r.post('/devices/:id/revoke', withCtx((ctx, req, res) => {
    if (ctx.userRole !== 'OWNER') throw new AppError('Only the owner can revoke devices.', 403);
    if (req.params.id === ctx.deviceId) throw new AppError('You cannot revoke the device you are using.');
    updateRow(ctx, 'devices', req.params.id!, { status: 'REVOKED' });
    audit(ctx, 'device.revoked', 'devices', req.params.id!);
    res.json({ ok: true });
  }));

  // ---- expenses & maintenance ----
  r.get('/expenses/categories', (_req, res) => res.json(EXPENSE_CATEGORIES));
  r.get('/expenses', withCtx((ctx, req, res) => res.json(listExpenses(ctx, req.query.propertyId as string | undefined))));
  r.post('/expenses', withCtx((ctx, req, res) => res.json(createExpense(ctx, req.body))));
  r.get('/maintenance', withCtx((ctx, req, res) => res.json(listMaintenance(ctx, req.query.open === '1'))));
  r.post('/maintenance', withCtx((ctx, req, res) => res.json(createMaintenance(ctx, req.body))));
  r.post('/maintenance/:id/status', withCtx((ctx, req, res) => {
    updateMaintenanceStatus(ctx, req.params.id!, req.body);
    res.json({ ok: true });
  }));

  return r;
}

/** Friendly errors to users; technical detail to developer logs (§53). */
export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error('[kitabu] unexpected error:', err);
  const msg = String(err?.message ?? '');
  if (msg.includes('UNIQUE constraint failed: payments')) {
    res.status(400).json({ error: 'This transaction reference has already been used on another payment.' });
    return;
  }
  res.status(500).json({ error: 'Something went wrong saving your data. Your earlier records are safe. Please try again.' });
}
