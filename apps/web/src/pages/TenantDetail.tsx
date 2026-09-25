import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { api, type TenantDetail } from '../api.ts';
import { useApp } from '../App.tsx';
import { Card, Chip, ErrorBanner, Spinner, balanceChip, monthStatusChip, confirmAction, promptReason } from '../components.tsx';
import { dateKe, ksh, monthLabel, parseKsh, phoneKe } from '../format.ts';

/** Tenant detail (UX.md screen 7): one person, whole history, nothing hidden. */
export default function TenantDetail() {
  const { id } = useParams();
  const { isOwner } = useApp();
  const [data, setData] = useState<TenantDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    if (id === undefined) return;
    try {
      setData(await api<TenantDetail>(`/api/tenants/${id}`));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this tenant.');
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (data === null) {
    return <>{error !== null && <ErrorBanner message={error} />}<Spinner /></>;
  }

  const { tenant, active } = data;

  async function changeRent(): Promise<void> {
    if (active === null) return;
    const input = window.prompt(`New monthly rent for ${tenant.full_name} (KSh):`, String(active.tenancy.current_rent_minor / 100));
    if (input === null) return;
    const rentMinor = parseKsh(input);
    if (rentMinor === null) {
      setError('Enter the rent as an amount, for example 14000.');
      return;
    }
    const effectiveFrom = window.prompt('Effective from (YYYY-MM-DD):', new Date().toISOString().slice(0, 10));
    if (effectiveFrom === null) return;
    try {
      await api(`/api/tenancies/${active.tenancy.id}/change-rent`, {
        body: { rentMinor, effectiveFrom, reason: 'Rent changed' },
      });
      setNotice('Rent updated — the change is recorded in the rent history. Old charges are untouched.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the rent.');
    }
  }

  async function endTenancy(): Promise<void> {
    if (active === null) return;
    if (!confirmAction(
      `End ${tenant.full_name}'s tenancy in house ${active.unitLabel}?\n\nThe house becomes vacant. Payment history and receipts are preserved forever.`,
    )) return;
    const reason = promptReason('End tenancy');
    if (reason === null) return;
    try {
      await api(`/api/tenancies/${active.tenancy.id}/end`, {
        body: { endDate: new Date().toISOString().slice(0, 10), reason: reason === '' ? undefined : reason },
      });
      setNotice(`Tenancy ended. ${active.unitLabel} is now vacant — history preserved.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not end the tenancy.');
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{tenant.full_name}</h1>
          <p className="sub">
            {active !== null
              ? <>House {active.unitLabel} · {active.propertyName} · since {dateKe(active.tenancy.start_date)}</>
              : 'No active tenancy'}
          </p>
        </div>
        <div className="card-actions">
          {active !== null && (
            <button className="btn-primary" onClick={() => navigate(`/pay?tenancyId=${active.tenancy.id}`)}>Record payment</button>
          )}
        </div>
      </div>

      {error !== null && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {notice !== null && <div className="banner banner-success">✓ {notice}</div>}

      <div className="grid-2">
        <Card title="Contact">
          <dl className="kv">
            <dt>Phone</dt><dd>{phoneKe(tenant.phone)}</dd>
            <dt>ID number</dt><dd>{tenant.id_number ?? '—'}</dd>
            {tenant.notes !== null && tenant.notes !== '' && (<><dt>Notes</dt><dd>{tenant.notes}</dd></>)}
          </dl>
        </Card>
        {active !== null && (
          <Card title="Tenancy">
            <dl className="kv">
              <dt>Rent</dt><dd>{ksh(active.tenancy.current_rent_minor)} / month (due day {active.tenancy.expected_payment_day})</dd>
              <dt>Deposit</dt><dd>{active.tenancy.deposit_amount_minor > 0 ? `${ksh(active.tenancy.deposit_amount_minor)}${active.tenancy.deposit_paid === 1 ? ' (paid)' : ''}` : '—'}</dd>
              <dt>Balance</dt><dd>{balanceChip(active.balanceMinor)}</dd>
            </dl>
            {isOwner && (
              <div className="form-row" style={{ marginTop: 12 }}>
                <button className="btn-small" onClick={() => void changeRent()}>Change rent</button>
                <button className="btn-small btn-danger" onClick={() => void endTenancy()}>End tenancy</button>
              </div>
            )}
          </Card>
        )}
      </div>

      {active !== null && (
        <>
          <Card title="Recent months">
            <div className="method-chips">
              {active.months.map((m) => (
                <span key={m.month} className="month-pill">
                  {monthLabel(m.month).split(' ')[0]} {monthStatusChip(m.status)}
                </span>
              ))}
            </div>
          </Card>

          <Card title="Statement" actions={<span className="field-hint">Balance {ksh(active.statement.balanceMinor)}</span>}>
            {active.statement.entries.length === 0
              ? <p className="empty">No entries yet — charges appear when the month is generated.</p>
              : (
                <table>
                  <thead><tr><th>Date</th><th>Entry</th><th className="num">Debit</th><th className="num">Credit</th><th className="num">Balance</th></tr></thead>
                  <tbody>
                    {active.statement.entries.map((e) => (
                      <tr key={e.id}>
                        <td>{dateKe(e.entry_date)}</td>
                        <td>{entryLabel(e.entry_type, e.period, e.kind, e.reason)}</td>
                        <td className="num">{e.direction === 'DEBIT' ? ksh(e.amount_minor) : ''}</td>
                        <td className="num">{e.direction === 'CREDIT' ? ksh(e.amount_minor) : ''}</td>
                        <td className="num strong">{ksh(e.balance_after_minor)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </Card>

          <Card title="Payments">
            {active.payments.length === 0
              ? <p className="empty">No payments recorded yet.</p>
              : (
                <table>
                  <thead><tr><th>Date</th><th>Method</th><th>Reference</th><th className="num">Amount</th><th>Status</th><th></th></tr></thead>
                  <tbody>
                    {active.payments.map((p) => (
                      <tr key={p.id}>
                        <td>{dateKe(p.paid_at)}</td>
                        <td>{methodName(p.method)}</td>
                        <td>{p.reference ?? '—'}</td>
                        <td className="num strong">{ksh(p.amount_minor)}</td>
                        <td><Chip tone={p.status === 'VERIFIED' ? 'green' : p.status === 'PENDING' ? 'amber' : p.status === 'REVERSED' ? 'gray' : 'red'}>{p.status.toLowerCase()}</Chip></td>
                        <td>{p.status === 'VERIFIED' && <Link to="/payments">▸</Link>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </Card>
        </>
      )}

      {data.history.length > 1 && (
        <Card title="House history">
          <table>
            <thead><tr><th>House</th><th>From</th><th>Until</th></tr></thead>
            <tbody>
              {data.history.map((h) => (
                <tr key={h.id}><td className="strong">{h.unit_label}</td><td>{dateKe(h.start_date)}</td><td>{h.end_date !== null ? dateKe(h.end_date) : 'now'}</td></tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}

function entryLabel(type: string, period: string | null, kind: string, reason: string | null): string {
  if (type === 'CHARGE') return period !== null ? `Rent — ${monthLabel(period)}` : `${kind.toLowerCase()} charge`;
  if (type === 'PAYMENT_CREDIT') return 'Payment received';
  if (type === 'REVERSAL') return `Reversal${reason !== null ? ` — ${reason}` : ''}`;
  return `Adjustment${reason !== null ? ` — ${reason}` : ''}`;
}

function methodName(m: string): string {
  if (m === 'MPESA') return 'M-Pesa';
  if (m === 'CASH') return 'Cash';
  if (m === 'BANK') return 'Bank';
  return m;
}
