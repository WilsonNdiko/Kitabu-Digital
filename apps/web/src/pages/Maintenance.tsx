import { useEffect, useState } from 'react';
import { api } from '../api';

const NEXT: Record<string, { to: string; label: string }[]> = {
  REPORTED: [{ to: 'IN_PROGRESS', label: 'Start work' }, { to: 'COMPLETED', label: 'Mark done' }],
  ASSIGNED: [{ to: 'IN_PROGRESS', label: 'Start work' }, { to: 'COMPLETED', label: 'Mark done' }],
  IN_PROGRESS: [{ to: 'COMPLETED', label: 'Mark done' }],
  COMPLETED: [],
};

export default function Maintenance() {
  const [rows, setRows] = useState<any[]>([]);
  const [properties, setProperties] = useState<any[]>([]);
  const [adding, setAdding] = useState(false);
  const [propertyId, setPropertyId] = useState('');
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<'LOW' | 'MEDIUM' | 'HIGH'>('MEDIUM');
  const [err, setErr] = useState('');

  const load = () => api.get('/maintenance').then(setRows).catch(() => {});
  useEffect(() => {
    load();
    api.get('/properties').then((ps) => { setProperties(ps); if (ps.length === 1) setPropertyId(ps[0].id); });
  }, []);

  const save = async () => {
    setErr('');
    try {
      await api.post('/maintenance', { propertyId, title, priority });
      setTitle(''); setAdding(false);
      load();
    } catch (e: any) { setErr(e.message); }
  };

  const move = async (id: string, status: string) => {
    try { await api.post(`/maintenance/${id}/status`, { status }); load(); }
    catch (e: any) { setErr(e.message); }
  };

  return (
    <>
      <h1>Maintenance</h1>
      <p className="sub">Reported → In progress → Completed.</p>
      {err && <div className="alert error" style={{ marginBottom: 12 }}>{err}</div>}
      {!adding && <button className="btn" style={{ marginBottom: 14 }} onClick={() => setAdding(true)}>＋ Report Issue</button>}
      {adding && (
        <div className="card form" style={{ marginBottom: 14 }}>
          <div className="field">
            <label>What is the problem?</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Leaking tap, House A-3" autoFocus />
          </div>
          <div className="row">
            <div className="field">
              <label>Property</label>
              <select value={propertyId} onChange={(e) => setPropertyId(e.target.value)}>
                <option value="">— Choose —</option>
                {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Priority</label>
              <select value={priority} onChange={(e) => setPriority(e.target.value as any)}>
                <option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option>
              </select>
            </div>
          </div>
          <div className="row">
            <button className="btn secondary" onClick={() => setAdding(false)}>Cancel</button>
            <button className="btn" onClick={save} disabled={!propertyId || !title.trim()}>Save issue</button>
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="empty"><div className="big-emoji">🔧</div>No maintenance issues. Vizuri!</div>
      ) : (
        <table className="table">
          <thead><tr><th>Issue</th><th>Where</th><th>Priority</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id}>
                <td style={{ fontWeight: 600 }}>{m.title}<br /><small style={{ color: 'var(--muted)' }}>reported {m.reported_at.slice(0, 10)}</small></td>
                <td>{m.property_name}{m.unit_label ? ` · ${m.unit_label}` : ''}</td>
                <td><span className={`chip ${m.priority === 'HIGH' ? 'HIGH' : 'neutral'}`}>{m.priority}</span></td>
                <td><span className={`chip ${m.status}`}>{m.status.replace('_', ' ')}</span></td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {NEXT[m.status]?.map((n) => (
                    <button key={n.to} className="btn small secondary" style={{ marginRight: 6 }} onClick={() => move(m.id, n.to)}>{n.label}</button>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
