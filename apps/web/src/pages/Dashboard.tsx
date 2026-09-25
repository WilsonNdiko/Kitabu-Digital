import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { api, type DashboardData } from '../api.ts';
import { useApp } from '../App.tsx';
import { Card, Chip, ErrorBanner, Spinner, monthStatusChip } from '../components.tsx';
import { dateKe, ksh, monthLabel } from '../format.ts';

/** Home (UX.md screen 2): answer "how are my properties doing?" in seconds. */
export default function Dashboard() {
  const { state, isOwner, refreshState } = useApp();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    try {
      setData(await api<DashboardData>('/api/dashboard'));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the dashboard.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function generateCharges(): Promise<void> {
    setGenerating(true);
    setNotice(null);
    try {
      const result = await api<{ created: number; skipped: number; totalMinor: number }>('/api/ledger/generate-charges', {
        body: { month: data?.month },
      });
      setNotice(
        result.created === 0
          ? `Charges for ${monthLabel(data?.month ?? '')} are already up to date — ${result.skipped} house${result.skipped === 1 ? '' : 's'} checked, nothing double-charged.`
          : `Charged rent for ${result.created} house${result.created === 1 ? '' : 's'} — ${ksh(result.totalMinor)} added to the books.`,
      );
      await load();
      await refreshState();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not generate charges.');
    } finally {
      setGenerating(false);
    }
  }

  if (data === null) {
    return <>{error !== null && <ErrorBanner message={error} onDismiss={() => setError(null)} />}<Spinner /></>;
  }

  const firstName = (state?.org?.landlordName ?? '').split(' ')[0] ?? '';
  const rate = data.collection.rate;
  const owed = data.arrearsTotalMinor;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{firstName !== '' ? `Habari, ${firstName}` : 'Home'}</h1>
          <p className="sub">{monthLabel(data.month)} · {data.totals.occupied} of {data.totals.units} houses occupied</p>
        </div>
        <div className="card-actions">
          {isOwner && (
            <button onClick={() => void generateCharges()} disabled={generating}>
              {generating ? 'Charging…' : `Generate ${monthLabel(data.month).split(' ')[0]} charges`}
            </button>
          )}
          <button className="btn-primary" onClick={() => navigate('/pay')}>＋ Record payment</button>
        </div>
      </div>

      {error !== null && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {notice !== null && <div className="banner banner-success" role="status">✓ {notice}</div>}

      <div className="grid-4">
        <div className="stat">
          <div className="label">Collected this month</div>
          <div className="value">{ksh(data.collection.collectedMinor)}</div>
          <div className="sub">of {ksh(data.collection.expectedMinor)} expected{rate !== null ? ` · ${Math.round(rate * 100)}%` : ''}</div>
        </div>
        <div className="stat">
          <div className="label">Outstanding arrears</div>
          <div className="value" style={{ color: owed > 0 ? 'var(--red)' : 'var(--green)' }}>{ksh(owed)}</div>
          <div className="sub">{data.arrears.length} tenanc{data.arrears.length === 1 ? 'y' : 'ies'} owing</div>
        </div>
        <div className="stat">
          <div className="label">Waiting for verification</div>
          <div className="value" style={{ color: data.pendingCount > 0 ? 'var(--amber)' : undefined }}>{data.pendingCount}</div>
          <div className="sub">M-Pesa codes to check{data.pendingCount > 0 ? ' — ' : ''}{data.pendingCount > 0 && <Link to="/payments">open queue</Link>}</div>
        </div>
        <div className="stat">
          <div className="label">Properties</div>
          <div className="value">{data.totals.properties}</div>
          <div className="sub">{data.totals.occupied} occupied · {data.totals.units - data.totals.occupied} vacant</div>
        </div>
      </div>

      <Card title={`${monthLabel(data.month)} by house`}>
        {data.monthOverview.length === 0
          ? <p className="empty">No occupied houses yet — add a property and move a tenant in.</p>
          : (
            <table>
              <thead>
                <tr><th>Tenant</th><th>House</th><th className="num">Rent</th><th className="num">Paid</th><th>Status</th></tr>
              </thead>
              <tbody>
                {data.monthOverview.map((m) => (
                  <tr key={m.tenancyId} className="clickable" onClick={() => navigate(`/tenants/${m.tenantId}`)}>
                    <td className="strong">{m.tenantName}</td>
                    <td>{m.unitLabel}</td>
                    <td className="num">{ksh(m.chargeMinor)}</td>
                    <td className="num">{ksh(m.paidMinor)}</td>
                    <td>{monthStatusChip(m.status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </Card>

      {data.arrears.length > 0 && (
        <Card title={<span>Who owes you <Chip tone="red">{ksh(owed)}</Chip></span>} actions={<Link to="/payments">Payment history</Link>}>
          <table>
            <thead>
              <tr><th>Tenant</th><th>House</th><th className="num">Balance</th><th>Last payment</th></tr>
            </thead>
            <tbody>
              {data.arrears.slice(0, 6).map((a) => (
                <tr key={a.tenancyId}>
                  <td className="strong">{a.tenantName}</td>
                  <td>{a.unitLabel} · {a.propertyName}</td>
                  <td className="num" style={{ color: 'var(--red)', fontWeight: 600 }}>{ksh(a.balanceMinor)}</td>
                  <td>{dateKe(a.lastPaymentAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Card title="Recent activity">
        {data.recentAudit.length === 0
          ? <p className="empty">Nothing recorded yet.</p>
          : (
            <ul className="activity">
              {data.recentAudit.map((a) => (
                <li key={a.id}>
                  <span>{a.summary}</span>
                  <span className="when">{dateKe(a.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
      </Card>
    </>
  );
}
