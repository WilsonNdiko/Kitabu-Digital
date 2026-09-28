import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ksh } from '../api';

const ENTRY_LABEL: Record<string, string> = {
  CHARGE: 'Rent due', PAYMENT: 'Payment', ADJUSTMENT: 'Adjustment', CREDIT: 'Credit', REVERSAL: 'Reversal',
};

export default function TenantDetail() {
  const { id } = useParams();
  const [d, setD] = useState<any | null>(null);
  const [err, setErr] = useState('');

  const load = () => api.get(`/tenants/${id}`).then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [id]);
  if (err) return <div className="alert error">{err}</div>;
  if (!d) return null;

  const t = d.tenant;
  const active = d.activeTenancy;

  const endTenancy = async () => {
    if (!confirm(`Move ${t.full_name} out of ${active.unit_label}? All payment history stays safe.`)) return;
    try {
      await api.post(`/tenancies/${active.id}/end`, { endDate: new Date().toISOString().slice(0, 10) });
      load();
    } catch (e: any) { alert(e.message); }
  };

  return (
    <>
      <h1>{t.full_name}</h1>
      <p className="sub">
        {t.phone || 'No phone'} {active ? ` · ${active.unit_label}, ${active.property_name} · rent ${ksh(active.rent_minor)} · since ${active.start_date}` : ' · no house at the moment'}
      </p>

      {active && (
        <div className="balance-banner" style={{ marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 13, opacity: 0.8 }}>{d.balanceMinor > 0 ? 'Owes' : d.balanceMinor < 0 ? 'Credit (advance)' : 'Fully paid'}</div>
            <div className="amount">{ksh(Math.abs(d.balanceMinor))}</div>
          </div>
          <Link className="btn" style={{ background: '#fff', color: 'var(--green-dark)' }} to={`/payments/new?tenantId=${t.id}`}>＋ Record Payment</Link>
        </div>
      )}

      {active && d.statement.length > 0 && (
        <>
          <h2>Rent book</h2>
          <table className="table">
            <thead><tr><th>Date</th><th>Entry</th><th className="num">Amount</th><th className="num">Balance</th></tr></thead>
            <tbody>
              {[...d.statement].reverse().map((l: any) => (
                <tr key={l.id}>
                  <td>{l.effectiveDate}</td>
                  <td>
                    {ENTRY_LABEL[l.entryType] || l.entryType}
                    {l.period && l.entryType === 'CHARGE' ? ` — ${l.period}` : ''}
                    {l.memo && l.entryType !== 'CHARGE' ? ` — ${l.memo}` : ''}
                  </td>
                  <td className="num" style={{ color: l.amountMinor < 0 ? 'var(--green)' : undefined }}>{ksh(l.amountMinor)}</td>
                  <td className="num" style={{ fontWeight: 600 }}>{ksh(l.runningBalanceMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h2>Payments</h2>
      {d.payments.length === 0 ? (
        <div className="empty">No payments recorded yet.</div>
      ) : (
        <table className="table">
          <thead><tr><th>Date</th><th className="num">Amount</th><th>Method</th><th>Status</th><th>Receipt</th></tr></thead>
          <tbody>
            {d.payments.map((p: any) => (
              <tr key={p.id}>
                <td>{p.payment_date}</td>
                <td className="num" style={{ fontWeight: 600 }}>{ksh(p.amount_minor)}</td>
                <td>{p.method}{p.reference ? ` · ${p.reference}` : ''}</td>
                <td><span className={`chip ${p.status}`}>{p.status}</span></td>
                <td>{p.receipt_id ? <Link to={`/receipts/${p.receipt_id}`}>{p.receipt_no}</Link> : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {d.tenancies.length > 1 && (
        <>
          <h2>Tenancy history</h2>
          <table className="table">
            <thead><tr><th>House</th><th>Property</th><th>Period</th><th className="num">Rent</th></tr></thead>
            <tbody>
              {d.tenancies.map((tc: any) => (
                <tr key={tc.id}>
                  <td>{tc.unit_label}</td><td>{tc.property_name}</td>
                  <td>{tc.start_date} → {tc.end_date || 'now'}</td>
                  <td className="num">{ksh(tc.rent_minor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {active && (
        <div style={{ marginTop: 22 }}>
          <button className="btn danger small" onClick={endTenancy}>Move out / end tenancy</button>
        </div>
      )}
    </>
  );
}
