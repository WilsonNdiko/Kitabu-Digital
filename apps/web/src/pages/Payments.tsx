import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ksh } from '../api';

export default function Payments() {
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('status') === 'PENDING' ? 'PENDING' : 'ALL';
  const [rows, setRows] = useState<any[]>([]);
  const [err, setErr] = useState('');

  const load = () =>
    api.get(`/payments${tab === 'PENDING' ? '?status=PENDING' : ''}`).then(setRows).catch(() => {});
  useEffect(() => { load(); }, [tab]);

  const act = async (fn: () => Promise<any>) => {
    setErr('');
    try { await fn(); load(); } catch (e: any) { setErr(e.message); }
  };

  const verify = (p: any) => act(() => api.post(`/payments/${p.id}/verify`));
  const reject = (p: any) => {
    const reason = prompt(`Why are you rejecting this ${ksh(p.amount_minor)} payment from ${p.tenant_name}?`);
    if (reason === null) return Promise.resolve();
    return act(() => api.post(`/payments/${p.id}/reject`, { reason }));
  };
  const reverse = (p: any) => {
    const reason = prompt(`Reverse ${ksh(p.amount_minor)} from ${p.tenant_name}? The original stays in history. Reason:`);
    if (reason === null) return Promise.resolve();
    return act(() => api.post(`/payments/${p.id}/reverse`, { reason }));
  };

  return (
    <>
      <h1>Payments</h1>
      <p className="sub">Payments you have recorded — Kitabu records payments made to you, it never moves money.</p>

      <div className="seg" style={{ marginBottom: 14 }}>
        <button className={tab === 'ALL' ? 'on' : ''} onClick={() => setSp({})}>All</button>
        <button className={tab === 'PENDING' ? 'on' : ''} onClick={() => setSp({ status: 'PENDING' })}>Needs verification</button>
      </div>
      <div className="quick-actions" style={{ margin: '0 0 14px' }}>
        <Link className="btn" to="/payments/new">＋ Record Payment</Link>
      </div>
      {err && <div className="alert error" style={{ marginBottom: 12 }}>{err}</div>}

      {rows.length === 0 ? (
        <div className="empty"><div className="big-emoji">💰</div>{tab === 'PENDING' ? 'Nothing waiting for verification.' : 'No payments recorded yet.'}</div>
      ) : (
        <table className="table">
          <thead><tr><th>Date</th><th>Tenant</th><th className="num">Amount</th><th>Method / Ref</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id}>
                <td>{p.payment_date}</td>
                <td><Link to={`/tenants/${p.tenant_id}`}>{p.tenant_name}</Link><br /><small style={{ color: 'var(--muted)' }}>{p.unit_label} · {p.property_name}</small></td>
                <td className="num" style={{ fontWeight: 700 }}>{ksh(p.amount_minor)}</td>
                <td>{p.method}{p.reference ? <><br /><small>{p.reference}</small></> : ''}</td>
                <td><span className={`chip ${p.status}`}>{p.status}</span>{p.rejected_reason && <><br /><small style={{ color: 'var(--muted)' }}>{p.rejected_reason}</small></>}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {(p.status === 'PENDING' || p.status === 'VERIFYING') && (
                    <>
                      <button className="btn small" onClick={() => verify(p)}>Verify</button>{' '}
                      <button className="btn small danger" onClick={() => reject(p)}>Reject</button>
                    </>
                  )}
                  {p.status === 'VERIFIED' && (
                    <>
                      {p.receipt_id && <Link className="btn small secondary" to={`/receipts/${p.receipt_id}`}>Receipt</Link>}{' '}
                      <button className="btn small ghost" onClick={() => reverse(p)} title="Reverse (keeps history)">↩</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
