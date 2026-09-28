import { useEffect, useState } from 'react';
import { api, ksh, monthName } from '../api';

function downloadCsv(filename: string, header: string[], rows: (string | number)[][]) {
  const esc = (v: string | number) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [header, ...rows].map((r) => r.map(esc).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

const sh = (minor: number) => minor / 100; // CSV numbers in whole shillings

export default function Reports() {
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const [collection, setCollection] = useState<any | null>(null);
  const [expenses, setExpenses] = useState<any | null>(null);
  const [occupancy, setOccupancy] = useState<any[]>([]);

  useEffect(() => {
    api.get(`/reports/collection?period=${period}`).then(setCollection).catch(() => {});
    api.get(`/reports/expenses?from=${period}-01&to=${period}-31`).then(setExpenses).catch(() => {});
    api.get('/reports/occupancy').then(setOccupancy).catch(() => {});
  }, [period]);

  if (!collection || !expenses) return null;

  return (
    <>
      <h1>Reports</h1>
      <p className="sub">Rent collection, expenses and occupancy — exportable for your records or your accountant.</p>

      <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)}
        style={{ padding: '10px 13px', border: '1.5px solid var(--line)', borderRadius: 11, marginBottom: 16 }} />

      <h2 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        Rent collection — {monthName(collection.period)}
        <button className="btn small secondary" onClick={() => downloadCsv(
          `rent-collection-${collection.period}.csv`,
          ['Property', 'House', 'Tenant', 'Phone', 'Rent (KSh)', 'Charged (KSh)', 'Paid (KSh)', 'Balance (KSh)', 'Status'],
          collection.tenants.map((t: any) => [t.propertyName, t.unitLabel, t.tenantName, t.phone ?? '', sh(t.rentMinor), sh(t.chargedMinor), sh(t.paidMinor), sh(t.balanceMinor), t.monthStatus]),
        )}>⬇ CSV</button>
      </h2>
      <table className="table">
        <thead><tr><th>Property</th><th className="num">Tenancies</th><th className="num">Expected</th><th className="num">Collected</th><th className="num">Outstanding</th><th className="num">Rate</th></tr></thead>
        <tbody>
          {collection.properties.map((p: any) => (
            <tr key={p.propertyId}>
              <td style={{ fontWeight: 600 }}>{p.propertyName}</td>
              <td className="num">{p.tenancies}</td>
              <td className="num">{ksh(p.expectedMinor)}</td>
              <td className="num" style={{ color: 'var(--green)' }}>{ksh(p.collectedMinor)}</td>
              <td className="num" style={{ color: p.outstandingMinor > 0 ? 'var(--red)' : undefined }}>{ksh(p.outstandingMinor)}</td>
              <td className="num"><span className={`chip ${p.ratePct >= 100 ? 'ok' : p.ratePct >= 60 ? 'warn' : 'bad'}`}>{p.ratePct}%</span></td>
            </tr>
          ))}
          <tr style={{ background: '#fafdfb' }}>
            <td style={{ fontWeight: 800 }}>Total</td>
            <td className="num" />
            <td className="num" style={{ fontWeight: 700 }}>{ksh(collection.total.expectedMinor)}</td>
            <td className="num" style={{ fontWeight: 700, color: 'var(--green)' }}>{ksh(collection.total.collectedMinor)}</td>
            <td className="num" style={{ fontWeight: 700 }}>{ksh(collection.total.outstandingMinor)}</td>
            <td className="num" style={{ fontWeight: 700 }}>{collection.total.ratePct}%</td>
          </tr>
        </tbody>
      </table>

      <h2 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        Expenses — {monthName(period)}
        <button className="btn small secondary" onClick={() => downloadCsv(
          `expenses-${period}.csv`,
          ['Category', 'Count', 'Total (KSh)'],
          expenses.byCategory.map((c: any) => [c.category, c.count, sh(c.totalMinor)]),
        )}>⬇ CSV</button>
      </h2>
      {expenses.byCategory.length === 0 ? (
        <div className="empty">No expenses recorded in this month.</div>
      ) : (
        <table className="table">
          <thead><tr><th>Category</th><th className="num">Count</th><th className="num">Total</th></tr></thead>
          <tbody>
            {expenses.byCategory.map((c: any) => (
              <tr key={c.category}><td><span className="chip neutral">{c.category}</span></td><td className="num">{c.count}</td><td className="num" style={{ fontWeight: 600 }}>{ksh(c.totalMinor)}</td></tr>
            ))}
            <tr style={{ background: '#fafdfb' }}><td style={{ fontWeight: 800 }}>Total</td><td className="num" /><td className="num" style={{ fontWeight: 700 }}>{ksh(expenses.totalMinor)}</td></tr>
          </tbody>
        </table>
      )}

      <h2 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        Occupancy
        <button className="btn small secondary" onClick={() => downloadCsv(
          'occupancy.csv',
          ['Property', 'Houses', 'Occupied', 'Vacant', 'Maintenance'],
          occupancy.map((o: any) => [o.propertyName, o.units, o.occupied, o.vacant, o.maintenance]),
        )}>⬇ CSV</button>
      </h2>
      <table className="table">
        <thead><tr><th>Property</th><th className="num">Houses</th><th className="num">Occupied</th><th className="num">Vacant</th><th className="num">Occupancy</th></tr></thead>
        <tbody>
          {occupancy.map((o: any) => (
            <tr key={o.propertyId}>
              <td style={{ fontWeight: 600 }}>{o.propertyName}</td>
              <td className="num">{o.units}</td>
              <td className="num" style={{ color: 'var(--green)' }}>{o.occupied}</td>
              <td className="num">{o.vacant}</td>
              <td className="num"><span className={`chip ${o.units && o.occupied / o.units >= 0.8 ? 'ok' : 'warn'}`}>{o.units ? Math.round((o.occupied / o.units) * 100) : 0}%</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
