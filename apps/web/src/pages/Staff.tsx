import { useEffect, useState } from 'react';
import { api } from '../api';

const ROLE_LABEL: Record<string, string> = { OWNER: 'Owner', MANAGER: 'Manager', CARETAKER: 'Caretaker' };

export default function Staff({ meRole }: { meRole?: string }) {
  const [rows, setRows] = useState<any[]>([]);
  const [adding, setAdding] = useState(false);
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<'MANAGER' | 'CARETAKER'>('CARETAKER');
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');

  const load = () => api.get('/users').then(setRows).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  const save = async () => {
    setErr('');
    try {
      await api.post('/users', { fullName, phone, role, pin: pin || undefined });
      setFullName(''); setPhone(''); setPin(''); setAdding(false);
      load();
    } catch (e: any) { setErr(e.message); }
  };

  const deactivate = async (u: any) => {
    if (!confirm(`Deactivate ${u.full_name}? They will no longer be able to use Kitabu on any device.`)) return;
    try { await api.post(`/users/${u.id}/deactivate`); load(); } catch (e: any) { setErr(e.message); }
  };

  return (
    <>
      <h1>Staff</h1>
      <p className="sub">
        Managers can verify payments and see reports. Caretakers can register tenants, record payments
        (held for your approval) and report maintenance — they never see your financial reports.
      </p>
      {err && <div className="alert error" style={{ marginBottom: 12 }}>{err}</div>}

      {meRole === 'OWNER' && !adding && <button className="btn" style={{ marginBottom: 14 }} onClick={() => setAdding(true)}>＋ Add Staff</button>}
      {adding && (
        <div className="card form" style={{ marginBottom: 14 }}>
          <div className="row">
            <div className="field"><label>Name</label><input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="e.g. Jane Njoki" autoFocus /></div>
            <div className="field"><label>Phone (optional)</label><input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="07xx xxx xxx" /></div>
          </div>
          <div className="row">
            <div className="field">
              <label>Role</label>
              <select value={role} onChange={(e) => setRole(e.target.value as any)}>
                <option value="CARETAKER">Caretaker</option>
                <option value="MANAGER">Manager</option>
              </select>
            </div>
            <div className="field">
              <label>PIN (optional, 4–8 digits)</label>
              <input inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} placeholder="e.g. 5678" />
            </div>
          </div>
          <div className="row">
            <button className="btn secondary" onClick={() => setAdding(false)}>Cancel</button>
            <button className="btn" onClick={save} disabled={!fullName.trim()}>Save staff member</button>
          </div>
        </div>
      )}

      <table className="table">
        <thead><tr><th>Name</th><th>Phone</th><th>Role</th><th>PIN</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {rows.map((u) => (
            <tr key={u.id}>
              <td style={{ fontWeight: 600 }}>{u.full_name}</td>
              <td>{u.phone || '—'}</td>
              <td><span className="chip neutral">{ROLE_LABEL[u.role] ?? u.role}</span></td>
              <td>{u.has_pin ? '✓' : '—'}</td>
              <td><span className={`chip ${u.status === 'ACTIVE' ? 'ok' : 'bad'}`}>{u.status}</span></td>
              <td>{meRole === 'OWNER' && u.role !== 'OWNER' && u.status === 'ACTIVE' && (
                <button className="btn small danger" onClick={() => deactivate(u)}>Deactivate</button>
              )}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="alert info" style={{ marginTop: 14 }}>
        Staff sign in from the lock screen (🔒 in the sidebar). On a paired device, after syncing, staff appear
        there too — Jane picks her own name on her phone and works under her own permissions.
      </div>
    </>
  );
}
