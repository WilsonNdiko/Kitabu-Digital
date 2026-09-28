import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ksh, toMinor } from '../api';

const METHODS = [
  { id: 'MPESA', label: 'M-Pesa' },
  { id: 'CASH', label: 'Cash' },
  { id: 'BANK', label: 'Bank' },
  { id: 'OTHER', label: 'Other' },
];

export default function RecordPayment() {
  const [sp] = useSearchParams();
  const [tenants, setTenants] = useState<any[]>([]);
  const [q, setQ] = useState('');
  const [tenantId, setTenantId] = useState(sp.get('tenantId') || '');
  const [balance, setBalance] = useState<number | null>(null);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('MPESA');
  const [reference, setReference] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<any | null>(null);

  useEffect(() => { api.get('/tenants').then(setTenants).catch(() => {}); }, []);

  const withHouse = useMemo(() => tenants.filter((t) => t.tenancy_id), [tenants]);
  const filtered = useMemo(
    () => withHouse.filter((t) => !q || t.full_name.toLowerCase().includes(q.toLowerCase()) || (t.unit_label || '').toLowerCase().includes(q.toLowerCase())),
    [withHouse, q],
  );
  const tenant = withHouse.find((t) => t.id === tenantId);

  useEffect(() => {
    setBalance(null);
    if (!tenant) return;
    api.get(`/tenancies/${tenant.tenancy_id}/balance`).then((b) => {
      setBalance(b.balanceMinor);
      if (!amount && b.balanceMinor > 0) setAmount(String(b.balanceMinor / 100));
    }).catch(() => {});
  }, [tenantId]);

  const save = async () => {
    setErr(''); setBusy(true);
    try {
      const res = await api.post('/payments', {
        tenancyId: tenant!.tenancy_id,
        amountMinor: toMinor(amount),
        method, reference: reference || undefined, paymentDate: date,
      });
      setDone(res);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  if (done) {
    return (
      <div style={{ maxWidth: 480, margin: '40px auto', textAlign: 'center' }}>
        <div style={{ fontSize: 46 }}>{done.status === 'VERIFIED' ? '✅' : '⏳'}</div>
        <h1>{done.status === 'VERIFIED' ? 'Payment recorded & verified' : 'Payment recorded'}</h1>
        <p className="sub">
          {done.status === 'VERIFIED'
            ? 'It has been posted to the rent book and the receipt is ready.'
            : 'It is saved on this device and waiting for verification. The M-Pesa code will be checked against your statement — the rent book updates once you verify it.'}
        </p>
        <div className="quick-actions" style={{ justifyContent: 'center' }}>
          {done.receipt && <Link className="btn" to={`/receipts/${done.receipt.id}`}>View receipt</Link>}
          {done.status !== 'VERIFIED' && <Link className="btn" to="/payments?status=PENDING">Go to verification</Link>}
          <button className="btn secondary" onClick={() => { setDone(null); setTenantId(''); setAmount(''); setReference(''); setQ(''); }}>Record another</button>
        </div>
      </div>
    );
  }

  return (
    <>
      <h1>Record Payment</h1>
      <p className="sub">The tenant already paid you (M-Pesa, cash or bank). Record it here to update the rent book and issue a receipt — Kitabu never moves money.</p>
      {err && <div className="alert error" style={{ marginBottom: 12 }}>{err}</div>}

      <div className="card form" style={{ maxWidth: 560 }}>
        {!tenant ? (
          <div className="field">
            <label>Who paid?</label>
            <input placeholder="Search tenant or house…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
            <div style={{ marginTop: 8, maxHeight: 260, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 11 }}>
              {filtered.map((t) => (
                <div key={t.id} onClick={() => setTenantId(t.id)}
                  style={{ padding: '10px 13px', cursor: 'pointer', borderBottom: '1px solid var(--line)' }}>
                  <strong>{t.full_name}</strong>
                  <span style={{ color: 'var(--muted)', fontSize: 13 }}> · {t.unit_label}, {t.property_name}</span>
                </div>
              ))}
              {filtered.length === 0 && <div style={{ padding: 13, color: 'var(--muted)' }}>No tenants with a house found.</div>}
            </div>
          </div>
        ) : (
          <>
            <div className="alert info" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>
                <strong>{tenant.full_name}</strong> · {tenant.unit_label}, {tenant.property_name}<br />
                <small>{balance === null ? 'Checking balance…' : balance > 0 ? `Owes ${ksh(balance)}` : balance < 0 ? `Has ${ksh(-balance)} credit` : 'Fully paid up'}</small>
              </span>
              <button className="btn ghost small" onClick={() => { setTenantId(''); setAmount(''); }}>Change</button>
            </div>

            <div className="field">
              <label>Amount paid (KSh)</label>
              <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="12000" autoFocus />
            </div>

            <div className="field">
              <label>How did they pay?</label>
              <div className="seg">
                {METHODS.map((m) => (
                  <button key={m.id} className={method === m.id ? 'on' : ''} onClick={() => setMethod(m.id)}>{m.label}</button>
                ))}
              </div>
            </div>

            {(method === 'MPESA' || method === 'BANK') && (
              <div className="field">
                <label>{method === 'MPESA' ? 'M-Pesa transaction code' : 'Bank reference'}</label>
                <input value={reference} onChange={(e) => setReference(e.target.value.toUpperCase())} placeholder={method === 'MPESA' ? 'e.g. SFR8K2L9QX' : 'e.g. deposit slip no.'} />
                {method === 'MPESA' && <div className="hint">The payment stays “pending” until you verify the code against your M-Pesa messages/statement.</div>}
              </div>
            )}

            <div className="field"><label>Payment date</label><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>

            <button className="btn" onClick={save} disabled={busy || !amount}>{busy ? 'Saving…' : 'Save payment'}</button>
          </>
        )}
      </div>
    </>
  );
}
