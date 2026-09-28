import { useEffect, useState } from 'react';
import { api } from '../api';

export default function SyncPage() {
  const [s, setS] = useState<any | null>(null);
  const [devices, setDevices] = useState<any[]>([]);
  const [pairing, setPairing] = useState<any | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => Promise.all([
    api.get('/sync/status').then(setS),
    api.get('/devices').then(setDevices),
  ]).catch(() => {});
  useEffect(() => { load(); }, []);
  if (!s) return null;

  const startPairing = async () => {
    setErr('');
    try { setPairing(await api.post('/sync/pairing')); }
    catch (e: any) { setErr(e.message); }
  };

  const syncNow = async () => {
    setErr(''); setMsg(''); setBusy(true);
    try {
      const r = await api.post('/sync/now');
      const total = r.results.reduce((t: any, x: any) => ({
        applied: t.applied + x.pulled.applied, pushed: t.pushed + x.pushed,
      }), { applied: 0, pushed: 0 });
      setMsg(`✓ Synced with ${r.results.map((x: any) => x.peer).join(', ')} — received ${total.applied} change${total.applied === 1 ? '' : 's'}, sent ${total.pushed}.`);
      load();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const revoke = async (d: any) => {
    if (!confirm(`Revoke "${d.name}"? It will no longer be able to sync with your Kitabu.`)) return;
    try { await api.post(`/devices/${d.id}/revoke`); load(); }
    catch (e: any) { setErr(e.message); }
  };

  return (
    <>
      <h1>Sync & Devices</h1>
      <p className="sub">Everything is saved on this device first. Saved locally is not the same as synced.</p>

      {err && <div className="alert error" style={{ marginBottom: 12 }}>{err}</div>}
      {msg && <div className="alert ok" style={{ marginBottom: 12 }}>{msg}</div>}

      <div className="grid cols-2">
        <div className="card">
          <div className="label">This device</div>
          <div style={{ fontWeight: 700, fontSize: 17, margin: '6px 0 2px' }}>{s.device.name}</div>
          <div style={{ color: 'var(--muted)', fontSize: 13.5 }}>Receipt book code: <strong>{s.device.code}</strong></div>
          <div style={{ color: 'var(--muted)', fontSize: 13.5, marginTop: 6 }}>
            Address on this network:<br />
            {s.addresses?.map((a: string) => <code key={a} style={{ display: 'inline-block', marginRight: 8 }}>{a}</code>)}
          </div>
        </div>
        <div className="card">
          <div className="label">Changes waiting to sync</div>
          <div className={`big ${s.pendingChanges > 0 ? 'amber' : 'green'}`}>{s.pendingChanges}</div>
          <div style={{ color: 'var(--muted)', fontSize: 13.5 }}>Safe on this device; they transfer when you sync with a paired device.</div>
          {s.peers.length > 0 && (
            <button className="btn" style={{ marginTop: 10 }} onClick={syncNow} disabled={busy}>
              {busy ? 'Syncing…' : '🔄 Sync Now'}
            </button>
          )}
        </div>
      </div>

      <h2>Paired devices</h2>
      {devices.length <= 1 && s.peers.length === 0 ? (
        <div className="empty">No other devices yet. Pair your phone or your caretaker's phone below — no internet needed.</div>
      ) : (
        <table className="table">
          <thead><tr><th>Device</th><th>Code</th><th>Status</th><th>Last sync</th><th></th></tr></thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id}>
                <td style={{ fontWeight: 600 }}>{d.name}{d.id === s.device.id ? ' (this device)' : ''}</td>
                <td><code>{d.device_code}</code></td>
                <td><span className={`chip ${d.status === 'ACTIVE' ? 'ok' : 'bad'}`}>{d.status}</span></td>
                <td>{d.last_sync_at ? new Date(d.last_sync_at).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' }) : '—'}</td>
                <td>{d.id !== s.device.id && d.status === 'ACTIVE' && (
                  <button className="btn small danger" onClick={() => revoke(d)}>Revoke</button>
                )}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Add a device</h2>
      <div className="card">
        {!pairing ? (
          <>
            <p style={{ margin: '0 0 10px', color: 'var(--muted)', fontSize: 14 }}>
              Connect both devices to the same Wi-Fi or to your phone's hotspot, then generate a pairing code.
              On the new device, open Kitabu and choose <strong>“Join your landlord's Kitabu”</strong>.
            </p>
            <button className="btn" onClick={startPairing}>＋ Add Device</button>
          </>
        ) : (
          <div style={{ textAlign: 'center' }}>
            <div className="label">Pairing code (valid {pairing.expiresInMinutes} minutes, single use)</div>
            <div style={{ fontSize: 42, fontWeight: 800, letterSpacing: 8, color: 'var(--green-dark)', margin: '8px 0' }}>{pairing.code}</div>
            <div style={{ color: 'var(--muted)', fontSize: 14 }}>
              On the new device, enter this code together with one of these addresses:<br />
              {pairing.addresses.map((a: string) => <code key={a} style={{ display: 'inline-block', margin: 4 }}>{a}</code>)}
            </div>
            <button className="btn secondary small" style={{ marginTop: 10 }} onClick={() => setPairing(null)}>Done</button>
          </div>
        )}
      </div>

      <div className="alert info" style={{ marginTop: 16 }}>
        <strong>No internet needed:</strong> devices exchange changes directly over local Wi-Fi or a hotspot.
        Payments and receipts can never be duplicated by syncing — every change carries a unique identity.
        Cloud backup (optional) arrives in Phase 5.
      </div>
    </>
  );
}
