import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';

export default function Properties() {
  const [rows, setRows] = useState<any[]>([]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [err, setErr] = useState('');

  const load = () => api.get('/properties').then(setRows).catch(() => {});
  useEffect(() => { load(); }, []);

  const add = async () => {
    setErr('');
    try {
      await api.post('/properties', { name, location });
      setName(''); setLocation(''); setAdding(false);
      load();
    } catch (e: any) { setErr(e.message); }
  };

  return (
    <>
      <h1>My Properties</h1>
      <p className="sub">Tap a property to see its houses.</p>
      {err && <div className="alert error" style={{ marginBottom: 12 }}>{err}</div>}
      {!adding && <button className="btn" style={{ marginBottom: 16 }} onClick={() => setAdding(true)}>＋ Add Property</button>}
      {adding && (
        <div className="card form" style={{ marginBottom: 16 }}>
          <div className="field"><label>Property name</label><input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></div>
          <div className="field"><label>Location (optional)</label><input value={location} onChange={(e) => setLocation(e.target.value)} /></div>
          <div className="row">
            <button className="btn secondary" onClick={() => setAdding(false)}>Cancel</button>
            <button className="btn" onClick={add} disabled={!name.trim()}>Save property</button>
          </div>
        </div>
      )}

      <div className="grid cols-2">
        {rows.map((p) => (
          <Link key={p.id} to={`/properties/${p.id}`} className="card">
            <div style={{ fontWeight: 700, fontSize: 16 }}>{p.name}</div>
            <div style={{ color: 'var(--muted)', fontSize: 13.5, margin: '3px 0 8px' }}>{p.location || '—'}</div>
            <span className="chip ok">{p.occupied} occupied</span>{' '}
            <span className="chip neutral">{p.units - p.occupied} vacant</span>
          </Link>
        ))}
      </div>
      {rows.length === 0 && <div className="empty"><div className="big-emoji">🏢</div>No properties yet — add your first property.</div>}
    </>
  );
}
