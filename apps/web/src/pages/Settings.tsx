import { useCallback, useEffect, useState } from 'react';

import { api, type UserRow } from '../api.ts';
import { useApp } from '../App.tsx';
import { Card, Chip, ErrorBanner, Field, SuccessBanner, confirmAction } from '../components.tsx';
import { phoneKe } from '../format.ts';

/** Settings (UX.md screens 22–23): organization, team, and the story of the books. */
export default function Settings() {
  const { state, refreshState, isOwner } = useApp();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [users, setUsers] = useState<UserRow[]>([]);

  const [name, setName] = useState('');
  const [landlordName, setLandlordName] = useState('');
  const [kraPin, setKraPin] = useState('');
  const [phone, setPhone] = useState('');
  const [unitTerm, setUnitTerm] = useState('House');

  const [newUserName, setNewUserName] = useState('');
  const [newUserRole, setNewUserRole] = useState<'MANAGER' | 'CARETAKER'>('CARETAKER');

  const loadUsers = useCallback(async () => {
    try {
      setUsers(await api<UserRow[]>('/api/users'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the team.');
    }
  }, []);

  useEffect(() => {
    if (state?.org !== undefined) {
      setName(state.org.name);
      setLandlordName(state.org.landlordName ?? '');
      setKraPin(state.org.kraPin ?? '');
      setPhone(state.org.phone ?? '');
      setUnitTerm(state.org.unitTerm);
    }
  }, [state]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  async function saveOrg(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    try {
      await api('/api/organization', {
        body: {
          name,
          landlordName: landlordName === '' ? undefined : landlordName,
          kraPin: kraPin === '' ? undefined : kraPin,
          phone: phone === '' ? undefined : phone,
          unitTerm,
        },
      });
      setNotice('Organization details saved.');
      await refreshState();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the settings.');
    }
  }

  async function addUser(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    try {
      await api('/api/users', { body: { fullName: newUserName, role: newUserRole } });
      setNotice(`${newUserName} added as ${newUserRole.toLowerCase()}. They can record payments on a paired device.`);
      setNewUserName('');
      await loadUsers();
      await refreshState();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the team member.');
    }
  }

  async function resetDemo(): Promise<void> {
    if (!confirmAction(
      'Erase this device\'s books and start over?\n\nAll properties, tenants, payments and receipts on this device are removed. (Demo reset — in the shipped app this is a passphrase-protected restore.)',
    )) return;
    try {
      await api('/api/reset');
      window.localStorage.removeItem('kitabu.actingUser');
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reset.');
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="sub">Organization, team and this device.</p>
        </div>
      </div>

      {error !== null && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {notice !== null && <SuccessBanner>{notice}</SuccessBanner>}

      <Card title="Organization">
        <form onSubmit={(e) => void saveOrg(e)} className="form-grid">
          <Field label="Organization name"><input value={name} onChange={(e) => setName(e.target.value)} disabled={!isOwner} /></Field>
          <Field label="Landlord's name"><input value={landlordName} onChange={(e) => setLandlordName(e.target.value)} disabled={!isOwner} /></Field>
          <Field label="KRA PIN"><input value={kraPin} onChange={(e) => setKraPin(e.target.value)} disabled={!isOwner} /></Field>
          <Field label="Phone"><input value={phone} onChange={(e) => setPhone(e.target.value)} disabled={!isOwner} /></Field>
          <Field label="Unit term" hint="What a rental unit is called across the app">
            <select value={unitTerm} onChange={(e) => setUnitTerm(e.target.value)} disabled={!isOwner}>
              <option>House</option><option>Unit</option><option>Room</option><option>Apartment</option>
            </select>
          </Field>
          {isOwner && <div className="form-row" style={{ gridColumn: '1 / -1' }}><button className="btn-primary" type="submit">Save changes</button></div>}
        </form>
        {!isOwner && <p className="field-hint">Only the owner can change organization settings.</p>}
      </Card>

      <Card title="Team">
        <table style={{ marginBottom: 12 }}>
          <thead><tr><th>Name</th><th>Role</th><th>Phone</th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td className="strong">{u.full_name}{u.id === state?.actingUserId && <span className="field-hint"> (acting)</span>}</td>
                <td><Chip tone={u.role === 'OWNER' ? 'blue' : 'gray'}>{u.role.toLowerCase()}</Chip></td>
                <td>{phoneKe(u.phone)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {isOwner && (
          <form onSubmit={(e) => void addUser(e)} className="form-row">
            <div style={{ flex: 2, minWidth: 180 }}>
              <Field label="Add a team member">
                <input value={newUserName} onChange={(e) => setNewUserName(e.target.value)} placeholder="e.g. Jane Njeri" />
              </Field>
            </div>
            <div style={{ flex: 1, minWidth: 130 }}>
              <Field label="Role">
                <select value={newUserRole} onChange={(e) => setNewUserRole(e.target.value as 'MANAGER' | 'CARETAKER')}>
                  <option value="CARETAKER">Caretaker — records payments & tenants</option>
                  <option value="MANAGER">Manager — also edits tenants</option>
                </select>
              </Field>
            </div>
            <button className="btn-primary" type="submit" disabled={newUserName.trim() === ''}>Add</button>
          </form>
        )}
        <p className="field-hint" style={{ marginBottom: 0 }}>
          Roles are enforced by the books themselves, not the screen: caretakers record payments and tenants;
          only the owner verifies M-Pesa codes, issues receipts and changes rent.
        </p>
      </Card>

      <Card title="This device">
        <dl className="kv">
          <dt>Device</dt><dd>{state?.device?.name ?? '—'} ({state?.device?.platform === 'ANDROID' ? 'Android' : 'Windows'})</dd>
          <dt>Books</dt><dd>Stored on this device (SQLite). Cloud is optional and comes later — nothing is required.</dd>
          <dt>Sync</dt><dd><Chip tone="gray">Single device — pairing arrives in Milestone 5</Chip></dd>
        </dl>
      </Card>

      <Card title="About the books">
        <ul className="activity">
          <li>Every entry is permanent — corrections are reversals, never edits.</li>
          <li>Receipts are frozen the moment they are issued and sealed with a digest + digital signature.</li>
          <li>M-Pesa codes only become money when verified; the same code can never pay twice.</li>
          <li>Everything an owner does is written to a tamper-evident audit trail.</li>
        </ul>
      </Card>

      <Card title="Demo data">
        <p className="field-hint">
          This preview runs on this device's local database. Reset it to walk through first-run setup again.
        </p>
        <button className="btn-danger" onClick={() => void resetDemo()}>Erase books & start over</button>
      </Card>
    </>
  );
}
