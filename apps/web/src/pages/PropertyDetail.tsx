import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ksh, toMinor } from '../api';

export default function PropertyDetail() {
  const { id } = useParams();
  const [data, setData] = useState<any | null>(null);
  const [adding, setAdding] = useState(false);
  const [labels, setLabels] = useState('');
  const [rent, setRent] = useState('');
  const [err, setErr] = useState('');

  const load = () => api.get(`/properties/${id}`).then(setData).catch(() => {});
  useEffect(() => { load(); }, [id]);
  if (!data?.property) return null;

  const addUnits = async () => {
    setErr('');
    try {
      const rentMinor = toMinor(rent);
      const units = labels.split(',').map((s) => s.trim()).filter(Boolean).map((label) => ({ label, rentMinor }));
      if (!units.length) throw new Error('Enter house names separated by commas, e.g. C-1, C-2, C-3');
      await api.post(`/properties/${id}/units`, { units });
      setLabels(''); setRent(''); setAdding(false);
      load();
    } catch (e: any) { setErr(e.message); }
  };

  const occupied = data.units.filter((u: any) => u.status === 'OCCUPIED').length;

  return (
    <>
      <h1>{data.property.name}</h1>
      <p className="sub">{data.property.location || ''} · {data.units.length} houses · {occupied} occupied · {data.units.length - occupied} vacant</p>

      {err && <div className="alert error" style={{ marginBottom: 12 }}>{err}</div>}
      {!adding && <button className="btn secondary small" style={{ marginBottom: 14 }} onClick={() => setAdding(true)}>＋ Add houses</button>}
      {adding && (
        <div className="card form" style={{ marginBottom: 14 }}>
          <div className="field">
            <label>House names (comma-separated)</label>
            <input value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="C-1, C-2, C-3" autoFocus />
          </div>
          <div className="field"><label>Monthly rent (KSh)</label><input value={rent} onChange={(e) => setRent(e.target.value)} inputMode="numeric" placeholder="8500" /></div>
          <div className="row">
            <button className="btn secondary" onClick={() => setAdding(false)}>Cancel</button>
            <button className="btn" onClick={addUnits}>Save houses</button>
          </div>
        </div>
      )}

      <div className="units-grid">
        {data.units.map((u: any) => (
          <div key={u.id} className="unit-card">
            <div className="label">{u.label}</div>
            <div className="who">
              {u.tenant_name ? <Link to={`/tenants/${u.tenant_id}`}>{u.tenant_name}</Link> : <em>Vacant</em>}
            </div>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{ksh(u.monthly_rent_minor)}/mo</div>
            <div style={{ marginTop: 6 }}>
              {u.status === 'VACANT'
                ? <Link className="btn small secondary" to={`/tenants/new?unitId=${u.id}`}>Move in tenant</Link>
                : <span className={`chip ${u.status}`}>{u.status}</span>}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
