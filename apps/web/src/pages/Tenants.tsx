import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ksh } from '../api';

export default function Tenants() {
  const [rows, setRows] = useState<any[]>([]);
  const [q, setQ] = useState('');
  const nav = useNavigate();

  useEffect(() => {
    const t = setTimeout(() => {
      api.get(`/tenants${q ? `?q=${encodeURIComponent(q)}` : ''}`).then(setRows).catch(() => {});
    }, 150);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <>
      <h1>Tenants</h1>
      <p className="sub">Your tenant register — tap a tenant for their rent book.</p>
      <div className="row" style={{ marginBottom: 14, maxWidth: 560 }}>
        <input
          style={{ flex: 2, padding: '11px 13px', border: '1.5px solid var(--line)', borderRadius: 11 }}
          placeholder="Search name, phone or house…"
          value={q} onChange={(e) => setQ(e.target.value)}
        />
        <Link className="btn" to="/tenants/new" style={{ flex: 1, justifyContent: 'center' }}>＋ Add Tenant</Link>
      </div>

      {rows.length === 0 ? (
        <div className="empty"><div className="big-emoji">👥</div>No tenants {q ? `matching “${q}”` : 'yet — add your first tenant'}.</div>
      ) : (
        <table className="table">
          <thead><tr><th>Tenant</th><th>Phone</th><th>House</th><th className="num">Rent</th></tr></thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id} className="click" onClick={() => nav(`/tenants/${t.id}`)}>
                <td style={{ fontWeight: 600 }}>{t.full_name}</td>
                <td>{t.phone || '—'}</td>
                <td>{t.unit_label ? `${t.unit_label} · ${t.property_name}` : <span className="chip neutral">No house</span>}</td>
                <td className="num">{t.rent_minor ? ksh(t.rent_minor) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
