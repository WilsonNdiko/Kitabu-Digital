import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { api, type PaymentItem, type TenantListItem } from '../api.ts';
import { useApp } from '../App.tsx';
import { Card, ErrorBanner, Field, SuccessBanner, balanceChip } from '../components.tsx';
import { ksh, parseKsh, phoneKe, toKshInput } from '../format.ts';

/**
 * Record payment (UX.md §3) — the most-used flow, target ≤5 taps:
 * pick tenant → amount prefilled → method chip → (reference) → Save.
 * Never re-asks what the system already knows.
 */
export default function RecordPayment() {
  const [searchParams] = useSearchParams();
  const preselect = searchParams.get('tenancyId');
  const { isOwner } = useApp();

  const [tenants, setTenants] = useState<TenantListItem[]>([]);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<TenantListItem | null>(null);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<'CASH' | 'MPESA' | 'BANK'>('CASH');
  const [reference, setReference] = useState('');
  const [paidAt, setPaidAt] = useState(new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<PaymentItem | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    void (async () => {
      try {
        const list = await api<TenantListItem[]>('/api/tenants');
        const withTenancy = list.filter((t) => t.tenancy !== null);
        setTenants(withTenancy);
        if (preselect !== null) {
          const found = withTenancy.find((t) => t.tenancy?.id === preselect);
          if (found !== undefined) pick(found);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load tenants.');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preselect]);

  function pick(t: TenantListItem): void {
    setPicked(t);
    setError(null);
    setSaved(null);
    setReference('');
    const balance = t.balanceMinor ?? 0;
    const rent = t.tenancy?.current_rent_minor ?? 0;
    // Default to what is owed; if in advance, default to one month's rent.
    setAmount(toKshInput(balance > 0 ? balance : rent));
    setMethod('CASH');
  }

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === '') return tenants.slice(0, 8);
    return tenants
      .filter((t) =>
        t.tenant.full_name.toLowerCase().includes(q) ||
        (t.tenant.phone ?? '').includes(q) ||
        (t.unitLabel ?? '').toLowerCase().includes(q))
      .slice(0, 8);
  }, [tenants, query]);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (picked === null || picked.tenancy === null) return;
    const amountMinor = parseKsh(amount);
    if (amountMinor === null) {
      setError('Enter the amount the tenant paid, for example 8000.');
      return;
    }
    if (method === 'MPESA' && reference.trim() === '') {
      setError('Type the M-Pesa code from the SMS (for example QGH7XJ2M9L).');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ payment: PaymentItem }>('/api/payments', {
        body: {
          tenancyId: picked.tenancy.id,
          amountMinor,
          method,
          paidAt,
          reference: method === 'MPESA' ? reference.trim().toUpperCase() : undefined,
        },
      });
      setSaved(result.payment);
      setPicked(null);
      setAmount('');
      setReference('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the payment.');
    } finally {
      setBusy(false);
    }
  }

  async function issueReceipt(): Promise<void> {
    if (saved === null) return;
    try {
      const r = await api<{ receipt: { id: string } }>('/api/receipts', { body: { paymentId: saved.id } });
      navigate(`/receipts/${r.receipt.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not issue the receipt.');
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Record payment</h1>
          <p className="sub">Cash counts on the spot; M-Pesa codes wait for verification.</p>
        </div>
      </div>

      {error !== null && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {saved !== null && (
        <Card>
          <SuccessBanner>
            Saved on this device — {ksh(saved.amount_minor)} from {saved.tenantName} ({methodName(saved.method)}).
          </SuccessBanner>
          {saved.status === 'VERIFIED' ? (
            <div className="form-row">
              {isOwner && <button className="btn-primary" onClick={() => void issueReceipt()}>Issue receipt</button>}
              <button onClick={() => setSaved(null)}>Record another payment</button>
            </div>
          ) : (
            <p className="field-hint">
              Waiting for verification — the owner must confirm this M-Pesa code against the message before it counts
              in the books. <Link to="/payments">Open the verification queue</Link>.
            </p>
          )}
        </Card>
      )}

      <Card>
        {picked === null ? (
          <>
            <h3>Who is paying?</h3>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Type a name, phone or house…"
              autoFocus
              style={{ marginBottom: 12 }}
            />
            <table>
              <tbody>
                {matches.map((t) => (
                  <tr key={t.tenant.id} className="clickable" onClick={() => pick(t)}>
                    <td className="strong">{t.tenant.full_name}</td>
                    <td>{phoneKe(t.tenant.phone)}</td>
                    <td>{t.unitLabel}</td>
                    <td>{balanceChip(t.balanceMinor)}</td>
                  </tr>
                ))}
                {matches.length === 0 && (
                  <tr><td colSpan={4} className="empty">No tenant matches. Only tenants with an active house can pay.</td></tr>
                )}
              </tbody>
            </table>
          </>
        ) : (
          <form onSubmit={(e) => void submit(e)} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <h3>{picked.tenant.full_name}</h3>
              <p className="sub" style={{ margin: 0, color: 'var(--ink-soft)' }}>
                House {picked.unitLabel} · rent {ksh(picked.tenancy?.current_rent_minor ?? 0)} · balance {ksh(picked.balanceMinor ?? 0)}
              </p>
              <button type="button" className="btn-small btn-quiet" onClick={() => setPicked(null)} style={{ marginTop: 6 }}>
                ← choose someone else
              </button>
            </div>
            <div className="form-grid">
              <Field label="Amount paid (KSh)" hint={picked.balanceMinor !== null && picked.balanceMinor > 0 ? `Owes ${ksh(picked.balanceMinor)}` : undefined}>
                <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" autoFocus />
              </Field>
              <Field label="Date paid"><input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} /></Field>
            </div>
            <Field label="Method">
              <div className="method-chips">
                {(['CASH', 'MPESA', 'BANK'] as const).map((m) => (
                  <button key={m} type="button" className={method === m ? 'selected' : ''} onClick={() => setMethod(m)}>
                    {methodName(m)}
                  </button>
                ))}
              </div>
            </Field>
            {method === 'MPESA' && (
              <Field label="M-Pesa code" hint="The code from the confirmation SMS, e.g. QGH7XJ2M9L">
                <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="QGH7XJ2M9L" autoCapitalize="characters" style={{ textTransform: 'uppercase' }} />
              </Field>
            )}
            <div className="form-row">
              <button className="btn-primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save payment'}</button>
            </div>
          </form>
        )}
      </Card>
    </>
  );
}

function methodName(m: string): string {
  if (m === 'MPESA') return 'M-Pesa';
  if (m === 'BANK') return 'Bank';
  return 'Cash';
}
