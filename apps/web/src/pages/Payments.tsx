import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { api, type PaymentItem } from '../api.ts';
import { useApp } from '../App.tsx';
import { Card, ErrorBanner, Field, Spinner, paymentStatusChip } from '../components.tsx';
import { dateKe, ksh } from '../format.ts';

/**
 * Payments (UX.md screens 10–11): history plus the verification queue.
 * Pending M-Pesa codes become real money only when the owner checks them.
 */
export default function Payments() {
  const { isOwner } = useApp();
  const [filter, setFilter] = useState<'PENDING' | 'ALL'>('PENDING');
  const [items, setItems] = useState<PaymentItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    try {
      const path = filter === 'PENDING' ? '/api/payments?status=PENDING' : '/api/payments';
      setItems(await api<PaymentItem[]>(path));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load payments.');
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const pendingCount = items === null ? null : items.filter((p) => p.status === 'PENDING').length;

  async function verify(p: PaymentItem): Promise<void> {
    try {
      await api(`/api/payments/${p.id}/verify`, { body: { note: note.trim() === '' ? 'Checked against the M-Pesa message' : note.trim() } });
      setNotice(`Verified — ${ksh(p.amount_minor)} from ${p.tenantName} now counts in the books.`);
      setNote('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not verify the payment.');
    }
  }

  async function reject(p: PaymentItem): Promise<void> {
    const reason = window.prompt(`Reject this M-Pesa code from ${p.tenantName}? Give the reason:`);
    if (reason === null) return;
    try {
      await api(`/api/payments/${p.id}/reject`, { body: { reason } });
      setNotice('Payment rejected. Nothing was added to the books — the record stays in history.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reject the payment.');
    }
  }

  async function issueReceipt(p: PaymentItem): Promise<void> {
    try {
      const r = await api<{ receipt: { id: string } }>('/api/receipts', { body: { paymentId: p.id } });
      window.location.hash = '';
      window.location.assign(`#/receipts/${r.receipt.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not issue the receipt.');
    }
  }

  async function reverse(p: PaymentItem): Promise<void> {
    if (!window.confirm(
      `Reverse this payment of ${ksh(p.amount_minor)} from ${p.tenantName}?\n\nThe money is removed from the books with a reversal entry, and the receipt (if any) is voided. History stays visible. This is the only way corrections are made.`,
    )) return;
    const reason = window.prompt('Reason (kept in the audit trail):');
    if (reason === null) return;
    try {
      await api(`/api/payments/${p.id}/reverse`, { body: { reason } });
      setNotice('Payment reversed — the books now show the correction. Receipts were voided, not deleted.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reverse the payment.');
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Payments</h1>
          <p className="sub">Every shilling, with its verification story.</p>
        </div>
        <div className="card-actions">
          <button className={filter === 'PENDING' ? 'btn-primary' : ''} onClick={() => setFilter('PENDING')}>
            Waiting for verification{pendingCount !== null ? ` (${pendingCount})` : ''}
          </button>
          <button className={filter === 'ALL' ? 'btn-primary' : ''} onClick={() => setFilter('ALL')}>All payments</button>
        </div>
      </div>

      {error !== null && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {notice !== null && <div className="banner banner-success">✓ {notice}</div>}

      {filter === 'PENDING' && (
        <Card title="Verification queue">
          <p className="field-hint" style={{ marginTop: 0 }}>
            These M-Pesa codes were recorded but do not count in the books until you check them against the M-Pesa message.
          </p>
          {items !== null && items.some((p) => p.status === 'PENDING') && (
            <Field label="Verification note (optional, kept in the audit trail)">
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Code matched the 9:41 SMS" style={{ marginBottom: 10 }} />
            </Field>
          )}
        </Card>
      )}

      {items === null
        ? <Spinner />
        : items.length === 0
          ? <Card><p className="empty">{filter === 'PENDING' ? 'Nothing waiting — all M-Pesa codes are checked.' : 'No payments recorded yet.'}</p></Card>
          : (
            <Card>
              <table>
                <thead><tr><th>Date</th><th>Tenant</th><th>Method</th><th>Reference</th><th className="num">Amount</th><th>Status</th><th>Actions</th></tr></thead>
                <tbody>
                  {items.map((p) => (
                    <tr key={p.id}>
                      <td>{dateKe(p.paid_at)}</td>
                      <td className="strong">{p.tenantName}<span className="field-hint"> · {p.unitLabel}</span></td>
                      <td>{methodName(p.method)}</td>
                      <td>{p.reference ?? '—'}</td>
                      <td className="num strong">{ksh(p.amount_minor)}</td>
                      <td>{paymentStatusChip(p.status)}</td>
                      <td className="form-row" style={{ flexWrap: 'nowrap' }}>
                        {p.status === 'PENDING' && isOwner && (
                          <>
                            <button className="btn-small btn-primary" onClick={() => void verify(p)}>Verify</button>
                            <button className="btn-small btn-danger" onClick={() => void reject(p)}>Reject</button>
                          </>
                        )}
                        {p.status === 'VERIFIED' && isOwner && !p.hasReceipt && (
                          <button className="btn-small" onClick={() => void issueReceipt(p)}>Receipt</button>
                        )}
                        {p.status === 'VERIFIED' && isOwner && p.hasReceipt && <span className="chip chip-green">Receipt ✓</span>}
                        {p.status === 'VERIFIED' && isOwner && (
                          <button className="btn-small btn-quiet" title="Correction path" onClick={() => void reverse(p)}>Reverse</button>
                        )}
                        {p.status === 'REVERSED' && p.reversal_reason !== null && (
                          <span className="field-hint">{p.reversal_reason}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
      <p className="field-hint">
        Corrections are never edits: a wrong payment is reversed (with a reason) and, if needed, the right one recorded
        after. See <Link to="/settings">Settings → About the books</Link>.
      </p>
    </>
  );
}

function methodName(m: string): string {
  if (m === 'MPESA') return 'M-Pesa';
  if (m === 'CASH') return 'Cash';
  if (m === 'BANK') return 'Bank';
  return m;
}
