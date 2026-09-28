import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ksh } from '../api';

export function SearchBox() {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<any | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (q.trim().length < 2) { setRes(null); return; }
    const t = setTimeout(() => {
      api.get(`/search?q=${encodeURIComponent(q.trim())}`).then(setRes).catch(() => {});
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setRes(null); };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);

  const any = res && (res.tenants.length || res.payments.length || res.receipts.length || res.units.length);

  return (
    <div className="searchwrap" ref={box}>
      <span className="icon">🔍</span>
      <input
        placeholder="Search tenant, phone, house, M-Pesa code…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {res && (
        <div className="search-results">
          {!any && <div className="group" style={{ padding: '14px' }}>Nothing found for “{q}”.</div>}
          {res.tenants.length > 0 && <div className="group">Tenants</div>}
          {res.tenants.map((t: any) => (
            <Link key={t.id} to={`/tenants/${t.id}`} onClick={() => { setQ(''); setRes(null); }}>
              👤 {t.full_name} {t.unit_label ? `· ${t.unit_label}` : ''} {t.phone ? `· ${t.phone}` : ''}
            </Link>
          ))}
          {res.payments.length > 0 && <div className="group">Payments</div>}
          {res.payments.map((p: any) => (
            <Link key={p.id} to="/payments" onClick={() => { setQ(''); setRes(null); }}>
              💰 {ksh(p.amount_minor)} · {p.tenant_name} · {p.unit_label} · {p.reference || p.method} · {p.status}
            </Link>
          ))}
          {res.receipts.length > 0 && <div className="group">Receipts</div>}
          {res.receipts.map((r: any) => (
            <Link key={r.id} to={`/receipts/${r.id}`} onClick={() => { setQ(''); setRes(null); }}>
              🧾 {r.receipt_no}
            </Link>
          ))}
          {res.units.length > 0 && <div className="group">Houses</div>}
          {res.units.map((u: any) => (
            <Link key={u.id} to={`/properties/${u.property_id}`} onClick={() => { setQ(''); setRes(null); }}>
              🏠 {u.label} · {u.property_name} · {u.status}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
