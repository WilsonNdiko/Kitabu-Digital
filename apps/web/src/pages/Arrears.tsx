import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ksh, monthName } from '../api';

export default function Arrears() {
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const [propertyId, setPropertyId] = useState('');
  const [properties, setProperties] = useState<any[]>([]);
  const [data, setData] = useState<any | null>(null);

  useEffect(() => { api.get('/properties').then(setProperties).catch(() => {}); }, []);
  useEffect(() => {
    const qs = new URLSearchParams();
    if (period) qs.set('period', period);
    if (propertyId) qs.set('propertyId', propertyId);
    api.get(`/arrears?${qs}`).then(setData).catch(() => {});
  }, [period, propertyId]);

  if (!data) return null;

  return (
    <>
      <h1>Arrears</h1>
      <p className="sub">Who owes what — {monthName(data.period)}.</p>

      <div className="row" style={{ maxWidth: 480, marginBottom: 14 }}>
        <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)}
          style={{ padding: '10px 13px', border: '1.5px solid var(--line)', borderRadius: 11 }} />
        <select value={propertyId} onChange={(e) => setPropertyId(e.target.value)}
          style={{ padding: '10px 13px', border: '1.5px solid var(--line)', borderRadius: 11 }}>
          <option value="">All properties</option>
          {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>

      <div className="card" style={{ marginBottom: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="label">Total outstanding</span>
        <span style={{ fontSize: 24, fontWeight: 800, color: data.totalArrearsMinor > 0 ? 'var(--red)' : 'var(--green)' }}>
          {ksh(data.totalArrearsMinor)}
        </span>
      </div>

      {data.rows.length === 0 ? (
        <div className="empty"><div className="big-emoji">🎉</div>No one owes anything. Hongera!</div>
      ) : (
        <table className="table">
          <thead><tr><th>House</th><th>Tenant</th><th className="num">Rent</th><th className="num">Paid ({monthName(data.period).split(' ')[0]})</th><th className="num">Balance</th><th>Status</th></tr></thead>
          <tbody>
            {data.rows.map((r: any) => (
              <tr key={r.tenancyId}>
                <td style={{ fontWeight: 700 }}>{r.unitLabel}</td>
                <td><Link to={`/tenants/${r.tenantId}`}>{r.tenantName}</Link>{r.phone && <><br /><small style={{ color: 'var(--muted)' }}>{r.phone}</small></>}</td>
                <td className="num">{ksh(r.rentMinor)}</td>
                <td className="num">{ksh(r.paidMinor)}</td>
                <td className="num" style={{ fontWeight: 700, color: 'var(--red)' }}>{ksh(r.balanceMinor)}</td>
                <td><span className={`chip ${r.monthStatus}`}>{r.monthStatus}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
