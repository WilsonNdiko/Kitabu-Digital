import { useEffect, useState } from 'react';
import { api, ksh, toMinor } from '../api';

export default function Expenses() {
  const [rows, setRows] = useState<any[]>([]);
  const [cats, setCats] = useState<string[]>([]);
  const [properties, setProperties] = useState<any[]>([]);
  const [adding, setAdding] = useState(false);
  const [propertyId, setPropertyId] = useState('');
  const [category, setCategory] = useState('Repairs');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [err, setErr] = useState('');

  const load = () => api.get('/expenses').then(setRows).catch(() => {});
  useEffect(() => {
    load();
    api.get('/expenses/categories').then(setCats).catch(() => {});
    api.get('/properties').then((ps) => { setProperties(ps); if (ps.length === 1) setPropertyId(ps[0].id); });
  }, []);

  const save = async () => {
    setErr('');
    try {
      await api.post('/expenses', { propertyId, category, amountMinor: toMinor(amount), description, expenseDate: date });
      setAmount(''); setDescription(''); setAdding(false);
      load();
    } catch (e: any) { setErr(e.message); }
  };

  return (
    <>
      <h1>Expenses</h1>
      <p className="sub">Repairs, water, garbage, wages — the money going out.</p>
      {err && <div className="alert error" style={{ marginBottom: 12 }}>{err}</div>}
      {!adding && <button className="btn" style={{ marginBottom: 14 }} onClick={() => setAdding(true)}>＋ Add Expense</button>}
      {adding && (
        <div className="card form" style={{ marginBottom: 14 }}>
          <div className="row">
            <div className="field">
              <label>Property</label>
              <select value={propertyId} onChange={(e) => setPropertyId(e.target.value)}>
                <option value="">— Choose —</option>
                {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Category</label>
              <select value={category} onChange={(e) => setCategory(e.target.value)}>
                {cats.map((c) => <option key={c}>{c}</option>)}
              </select>
            </div>
          </div>
          <div className="row">
            <div className="field"><label>Amount (KSh)</label><input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" autoFocus /></div>
            <div className="field"><label>Date</label><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          </div>
          <div className="field"><label>Description</label><input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Blocked drain, Block B" /></div>
          <div className="row">
            <button className="btn secondary" onClick={() => setAdding(false)}>Cancel</button>
            <button className="btn" onClick={save} disabled={!propertyId || !amount}>Save expense</button>
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="empty"><div className="big-emoji">🧰</div>No expenses recorded yet.</div>
      ) : (
        <table className="table">
          <thead><tr><th>Date</th><th>Category</th><th>Description</th><th>Property</th><th className="num">Amount</th></tr></thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id}>
                <td>{e.expense_date}</td>
                <td><span className="chip neutral">{e.category}</span></td>
                <td>{e.description || '—'}</td>
                <td>{e.property_name}</td>
                <td className="num" style={{ fontWeight: 600 }}>{ksh(e.amount_minor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
