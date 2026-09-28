import { useState } from 'react';
import { api } from '../api';

const ROLE_LABEL: Record<string, string> = { OWNER: 'Owner', MANAGER: 'Manager', CARETAKER: 'Caretaker' };

export function LockScreen({ users, onUnlocked }: { users: any[]; onUnlocked: () => void }) {
  const [picked, setPicked] = useState<any | null>(users.length === 1 ? users[0] : null);
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const unlock = async (u: any, p: string) => {
    setErr(''); setBusy(true);
    try {
      await api.post('/auth/login', { userId: u.id, pin: p || undefined });
      onUnlocked();
    } catch (e: any) { setErr(e.message); setPin(''); } finally { setBusy(false); }
  };

  return (
    <div style={{ maxWidth: 420, margin: '0 auto', padding: '64px 20px', textAlign: 'center' }}>
      <div style={{ fontSize: 44 }}>🔒</div>
      <h1>Who is using this device?</h1>
      <p className="sub">Your records are safe on this device.</p>
      {err && <div className="alert error" style={{ marginBottom: 14 }}>{err}</div>}

      {!picked ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {users.map((u) => (
            <button key={u.id} className="btn secondary" style={{ justifyContent: 'space-between' }}
              onClick={() => (u.has_pin ? setPicked(u) : unlock(u, ''))}>
              <span>{u.full_name}</span>
              <span className="chip neutral">{ROLE_LABEL[u.role] ?? u.role}{u.has_pin ? ' · PIN' : ''}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="card form" style={{ maxWidth: 'none', textAlign: 'left' }}>
          <div style={{ fontWeight: 700 }}>{picked.full_name} <span className="chip neutral">{ROLE_LABEL[picked.role]}</span></div>
          {picked.has_pin ? (
            <div className="field">
              <label>Enter PIN</label>
              <input type="password" inputMode="numeric" value={pin} autoFocus
                style={{ letterSpacing: 8, fontSize: 22, textAlign: 'center' }}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                onKeyDown={(e) => e.key === 'Enter' && unlock(picked, pin)} />
            </div>
          ) : null}
          <div className="row">
            {users.length > 1 && <button className="btn secondary" onClick={() => { setPicked(null); setPin(''); setErr(''); }}>← Back</button>}
            <button className="btn" disabled={busy || (picked.has_pin && !pin)} onClick={() => unlock(picked, pin)}>
              {busy ? 'Unlocking…' : 'Unlock'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
