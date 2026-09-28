import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, ksh, toMinor } from '../api';

export default function AddTenant() {
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [idNumber, setIdNumber] = useState('');
  const [more, setMore] = useState(false);
  const [notes, setNotes] = useState('');
  const [properties, setProperties] = useState<any[]>([]);
  const [propertyId, setPropertyId] = useState('');
  const [units, setUnits] = useState<any[]>([]);
  const [unitId, setUnitId] = useState(sp.get('unitId') || '');
  const [rent, setRent] = useState('');
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.get('/properties').then((ps) => { setProperties(ps); if (ps.length === 1) setPropertyId(ps[0].id); }); }, []);
  useEffect(() => {
    if (!propertyId && !sp.get('unitId')) { setUnits([]); return; }
    const load = async () => {
      if (propertyId) {
        const d = await api.get(`/properties/${propertyId}`);
        setUnits(d.units.filter((u: any) => u.status === 'VACANT' || u.id === sp.get('unitId')));
      } else {
        // arrived with ?unitId= — find its property
        for (const p of await api.get('/properties')) {
          const d = await api.get(`/properties/${p.id}`);
          if (d.units.some((u: any) => u.id === sp.get('unitId'))) {
            setPropertyId(p.id);
            return;
          }
        }
      }
    };
    load().catch(() => {});
  }, [propertyId, properties.length]);

  const chosenUnit = useMemo(() => units.find((u: any) => u.id === unitId), [units, unitId]);

  const save = async () => {
    setErr(''); setBusy(true);
    try {
      const body: any = { fullName, phone, idNumber, notes };
      if (unitId) {
        body.moveIn = {
          unitId, startDate,
          rentMinor: rent ? toMinor(rent) : undefined,
        };
      }
      const res = await api.post('/tenants', body);
      nav(`/tenants/${res.id}`);
    } catch (e: any) { setErr(e.message); setBusy(false); }
  };

  return (
    <>
      <h1>Add Tenant</h1>
      <p className="sub">Only a name is required — you can fill in the rest anytime.</p>
      {err && <div className="alert error" style={{ marginBottom: 12 }}>{err}</div>}

      <div className="card form" style={{ maxWidth: 560 }}>
        <div className="field"><label>Full name</label><input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="e.g. John Kamau" autoFocus /></div>
        <div className="field"><label>Phone</label><input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="07xx xxx xxx" inputMode="tel" /></div>

        {!more && <button className="btn ghost" onClick={() => setMore(true)}>Add more details ▾</button>}
        {more && (
          <>
            <div className="field"><label>ID / Passport number</label><input value={idNumber} onChange={(e) => setIdNumber(e.target.value)} /></div>
            <div className="field"><label>Notes</label><textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
          </>
        )}

        <h2 style={{ margin: '8px 0 0' }}>Move into a house</h2>
        <div className="row">
          <div className="field">
            <label>Property</label>
            <select value={propertyId} onChange={(e) => { setPropertyId(e.target.value); setUnitId(''); }}>
              <option value="">— Later —</option>
              {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>House</label>
            <select value={unitId} onChange={(e) => setUnitId(e.target.value)} disabled={!propertyId}>
              <option value="">— Choose —</option>
              {units.map((u) => <option key={u.id} value={u.id}>{u.label} · {ksh(u.monthly_rent_minor)}/mo</option>)}
            </select>
          </div>
        </div>
        {unitId && (
          <div className="row">
            <div className="field">
              <label>Monthly rent (KSh)</label>
              <input value={rent} onChange={(e) => setRent(e.target.value)} placeholder={chosenUnit ? String(chosenUnit.monthly_rent_minor / 100) : ''} inputMode="numeric" />
              <div className="hint">Leave empty to use the house rent{chosenUnit ? ` (${ksh(chosenUnit.monthly_rent_minor)})` : ''}.</div>
            </div>
            <div className="field"><label>Move-in date</label><input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></div>
          </div>
        )}

        <button className="btn" onClick={save} disabled={busy || !fullName.trim()}>{busy ? 'Saving…' : 'Save tenant'}</button>
      </div>
    </>
  );
}
