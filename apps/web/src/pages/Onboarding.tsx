import { useState } from 'react';
import { api, toMinor } from '../api';

export default function Onboarding({ onDone }: { onDone: () => Promise<void> }) {
  const [step, setStep] = useState(0);
  const [ownerName, setOwnerName] = useState('');
  const [orgName, setOrgName] = useState('');
  const [propertyName, setPropertyName] = useState('');
  const [location, setLocation] = useState('');
  const [count, setCount] = useState('10');
  const [prefix, setPrefix] = useState('A-');
  const [rent, setRent] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setErr('');
    setBusy(true);
    try {
      const n = parseInt(count, 10);
      if (!n || n < 1 || n > 500) throw new Error('Enter how many houses (1–500).');
      const rentMinor = toMinor(rent);
      await api.post('/setup', {
        ownerName, orgName: orgName || `${ownerName.split(' ')[0]} Properties`, propertyName, location,
        units: Array.from({ length: n }, (_, i) => ({ label: `${prefix}${i + 1}`, rentMinor })),
      });
      await onDone();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const demo = async () => {
    setErr(''); setBusy(true);
    try { await api.post('/setup/demo'); await onDone(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <div style={{ maxWidth: 520, margin: '0 auto', padding: '48px 20px' }}>
      <div style={{ textAlign: 'center', marginBottom: 28 }}>
        <div style={{ fontSize: 44 }}>📗</div>
        <h1 style={{ fontSize: 30 }}>Karibu Kitabu</h1>
        <p className="sub">All your landlord books in one simple app. Works fully offline — no account, no internet needed.</p>
      </div>

      {err && <div className="alert error" style={{ marginBottom: 16 }}>{err}</div>}

      {step === 0 && (
        <div className="card form" style={{ maxWidth: 'none' }}>
          <div className="field">
            <label>Your name</label>
            <input value={ownerName} onChange={(e) => setOwnerName(e.target.value)} placeholder="e.g. Wilson Ndiko" autoFocus />
          </div>
          <div className="field">
            <label>Business name <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(optional)</span></label>
            <input value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="e.g. Wilson Properties" />
          </div>
          <button className="btn" disabled={!ownerName.trim() || busy} onClick={() => setStep(1)}>Continue →</button>
          <button className="btn ghost" disabled={busy} onClick={demo}>Or explore with sample data (Green View Apartments)</button>
        </div>
      )}

      {step === 1 && (
        <div className="card form" style={{ maxWidth: 'none' }}>
          <div className="field">
            <label>Your first property</label>
            <input value={propertyName} onChange={(e) => setPropertyName(e.target.value)} placeholder="e.g. Green View Apartments" autoFocus />
          </div>
          <div className="field">
            <label>Location <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(optional)</span></label>
            <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Kasarani, Nairobi" />
          </div>
          <div className="row">
            <div className="field">
              <label>How many houses?</label>
              <input value={count} onChange={(e) => setCount(e.target.value)} inputMode="numeric" />
            </div>
            <div className="field">
              <label>House names start with</label>
              <input value={prefix} onChange={(e) => setPrefix(e.target.value)} />
            </div>
          </div>
          <div className="field">
            <label>Monthly rent (KSh)</label>
            <input value={rent} onChange={(e) => setRent(e.target.value)} placeholder="e.g. 8500" inputMode="numeric" />
            <div className="hint">Houses will be named {prefix}1 … {prefix}{count || 'N'}. You can rename each and set different rents later.</div>
          </div>
          <div className="row">
            <button className="btn secondary" onClick={() => setStep(0)}>← Back</button>
            <button className="btn" disabled={busy || !propertyName.trim() || !rent} onClick={submit}>
              {busy ? 'Setting up…' : 'Finish setup'}
            </button>
          </div>
        </div>
      )}

      <p style={{ textAlign: 'center', fontSize: 12.5, color: 'var(--muted)', marginTop: 18 }}>
        Everything is stored on this device. You can add a cloud account later for backup — it is never required.
      </p>
    </div>
  );
}
