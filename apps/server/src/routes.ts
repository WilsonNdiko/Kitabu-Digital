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
import { seedDemo } from './seed.js';

export function buildRouter(db: DB): Router {
  const r = Router();

  const withCtx = (fn: (ctx: NonNullable<ReturnType<typeof getCtx>>, req: Request, res: Response) => void) =>
    (req: Request, res: Response, next: NextFunction) => {
      try {
        const ctx = getCtx(db);
        if (!ctx) throw new AppError('Kitabu is not set up on this device yet.', 409);
        fn(ctx, req, res);
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
  r.get('/sync/status', withCtx((ctx, _q, res) => res.json(syncStatus(ctx))));
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
