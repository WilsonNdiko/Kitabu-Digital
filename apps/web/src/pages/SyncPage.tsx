import { useEffect, useState } from 'react';
import { api } from '../api';

export default function SyncPage() {
  const [s, setS] = useState<any | null>(null);
  useEffect(() => { api.get('/sync/status').then(setS).catch(() => {}); }, []);
  if (!s) return null;

  return (
    <>
      <h1>Sync & Devices</h1>
      <p className="sub">Everything is saved on this device first. Saved locally is not the same as synced.</p>

      <div className="grid cols-2">
        <div className="card">
          <div className="label">This device</div>
          <div style={{ fontWeight: 700, fontSize: 17, margin: '6px 0 2px' }}>{s.device.name}</div>
          <div style={{ color: 'var(--muted)', fontSize: 13.5 }}>Receipt book code: <strong>{s.device.code}</strong></div>
        </div>
        <div className="card">
          <div className="label">Changes waiting to sync</div>
          <div className="big amber">{s.pendingChanges}</div>
          <div style={{ color: 'var(--muted)', fontSize: 13.5 }}>They are safe on this device and will sync when a paired device or the cloud is available.</div>
        </div>
        <div className="card">
          <div className="label">Nearby devices</div>
          <div style={{ margin: '8px 0', color: 'var(--muted)' }}>No paired devices yet.</div>
          <button className="btn small secondary" disabled title="Coming in Phase 4">＋ Add Device (QR pairing) — coming soon</button>
        </div>
        <div className="card">
          <div className="label">Cloud backup</div>
          <div style={{ margin: '8px 0', color: 'var(--muted)' }}>Not connected — and that's fine. Kitabu works fully offline.</div>
          <button className="btn small secondary" disabled title="Coming in Phase 5">Create cloud account — coming soon</button>
        </div>
      </div>

      <div className="alert info" style={{ marginTop: 16 }}>
        <strong>How sync will work:</strong> pair your caretaker's phone by scanning a QR code, then your devices
        exchange changes over local Wi-Fi or your phone's hotspot — no internet needed. A cloud account will be an
        optional extra for backup and remote access. See <code>docs/SYNC.md</code> in the project for the full design.
      </div>
    </>
  );
}
