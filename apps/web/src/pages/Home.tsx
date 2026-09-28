import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ksh, monthName } from '../api';

export default function Home() {
  const [d, setD] = useState<any | null>(null);
  useEffect(() => { api.get('/dashboard').then(setD).catch(() => {}); }, []);
  if (!d) return null;

  return (
    <>
      <h1>How are my properties doing?</h1>
      <p className="sub">{monthName(d.period)}</p>

      <div className="quick-actions">
        <Link className="btn" to="/payments/new">＋ Record Payment</Link>
        <Link className="btn secondary" to="/tenants/new">＋ Add Tenant</Link>
        <Link className="btn secondary" to="/expenses">＋ Expense</Link>
        <Link className="btn secondary" to="/maintenance">＋ Maintenance</Link>
      </div>

      {d.pendingVerification > 0 && (
        <div className="alert warn" style={{ background: 'var(--amber-bg)', color: 'var(--amber)', margin: '14px 0 0' }}>
          ⏳ {d.pendingVerification} payment{d.pendingVerification === 1 ? '' : 's'} waiting for your verification.{' '}
          <Link to="/payments?status=PENDING" style={{ color: 'inherit', textDecoration: 'underline' }}>Review now</Link>
        </div>
      )}

      <h2>This month</h2>
      <div className="grid cols-3">
        <div className="card"><div className="label">Expected rent</div><div className="big">{ksh(d.expectedMinor)}</div></div>
        <div className="card"><div className="label">Collected</div><div className="big green">{ksh(d.collectedMinor)}</div></div>
        <div className="card"><div className="label">Outstanding</div><div className={`big ${d.outstandingMinor > 0 ? 'amber' : 'green'}`}>{ksh(d.outstandingMinor)}</div></div>
      </div>

      <h2>Tenants</h2>
      <div className="grid cols-3">
        <Link to="/arrears" className="card"><div className="label">Paid</div><div className="big green">{d.tenants.paid}</div></Link>
        <Link to="/arrears" className="card"><div className="label">Partial</div><div className="big amber">{d.tenants.partial}</div></Link>
        <Link to="/arrears" className="card"><div className="label">Overdue</div><div className="big red">{d.tenants.overdue}</div></Link>
      </div>

      <h2>Portfolio</h2>
      <div className="grid cols-4">
        <Link to="/properties" className="card"><div className="label">Properties</div><div className="big">{d.properties}</div></Link>
        <Link to="/properties" className="card"><div className="label">Houses</div><div className="big">{d.units}</div></Link>
        <Link to="/properties" className="card"><div className="label">Occupied</div><div className="big green">{d.occupied}</div></Link>
        <Link to="/properties" className="card"><div className="label">Vacant</div><div className="big amber">{d.vacant}</div></Link>
      </div>

      {d.openMaintenance > 0 && (
        <>
          <h2>Maintenance</h2>
          <Link to="/maintenance" className="card" style={{ display: 'block' }}>
            <div className="label">Open issues</div><div className="big amber">{d.openMaintenance}</div>
          </Link>
        </>
      )}
    </>
  );
}
