import { useCallback, useEffect, useState } from 'react';

import { api, apiPostForBytes, type UserRow } from '../api.ts';
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

  const [exportPass, setExportPass] = useState('');
  const [exportPass2, setExportPass2] = useState('');
  const [exporting, setExporting] = useState(false);
  const [restorePass, setRestorePass] = useState('');
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoring, setRestoring] = useState(false);

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
      'Erase this device\'s books and start over?\n\nAll properties, tenants, payments and receipts on this device are removed. (Demo reset — to move your books to a new device, use the encrypted backup above.)',
    )) return;
    try {
      await api('/api/reset');
      window.localStorage.removeItem('kitabu.actingUser');
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reset.');
    }
  }

  async function exportBackup(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      setExporting(true);
      const { bytes, filename } = await apiPostForBytes('/api/backup/export', { passphrase: exportPass });
      const blob = new Blob([bytes as BlobPart], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename ?? 'kitabu-backup.kitabu';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setNotice('Encrypted backup downloaded. Keep the file and the passphrase somewhere safe — together they restore your books on any device.');
      setExportPass('');
      setExportPass2('');
      await refreshState();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the backup.');
    } finally {
      setExporting(false);
    }
  }

  async function restoreBackup(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (restoreFile === null) {
      setError('Choose the backup file to restore from.');
      return;
    }
    if (!confirmAction(
      'Restore from this backup?\n\nThe books currently on this device are replaced by the backup. The passphrase is checked first — nothing changes if it does not match.',
    )) return;
    try {
      setRestoring(true);
      const buffer = new Uint8Array(await restoreFile.arrayBuffer());
      let binary = '';
      for (let i = 0; i < buffer.length; i += 0x8000) {
        binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
      }
      const backupBase64 = btoa(binary);
      await api('/api/backup/restore', { body: { passphrase: restorePass, backupBase64 } });
      window.localStorage.removeItem('kitabu.actingUser');
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not restore the backup.');
      setRestoring(false);
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

      <Card title="Backup & restore">
        <p className="field-hint">
          One encrypted file holds your whole books — houses, tenants, payments, receipts, audit trail.
          If this laptop or phone is lost, the file plus the passphrase restores everything on a new device.
        </p>
        {isOwner ? (
          <>
            <dl className="kv">
              <dt>Last backup</dt>
              <dd>{state?.lastBackupAt != null ? new Date(state.lastBackupAt).toLocaleString() : 'Never — no backup on this device yet'}</dd>
            </dl>
            <form onSubmit={(e) => void exportBackup(e)} className="form-grid" style={{ marginTop: 12 }}>
              <Field label="Backup passphrase" hint="At least 8 characters. Needed to restore — Kitabu never stores it.">
                <input type="password" value={exportPass} onChange={(e) => setExportPass(e.target.value)} autoComplete="new-password" />
              </Field>
              <Field label="Repeat passphrase">
                <input type="password" value={exportPass2} onChange={(e) => setExportPass2(e.target.value)} autoComplete="new-password" />
              </Field>
              <div className="form-row" style={{ gridColumn: '1 / -1' }}>
                <button
                  className="btn-primary"
                  type="submit"
                  disabled={exporting || exportPass.length < 8 || exportPass !== exportPass2}
                >
                  {exporting ? 'Encrypting…' : 'Download encrypted backup'}
                </button>
              </div>
            </form>
            <form onSubmit={(e) => void restoreBackup(e)} className="form-grid" style={{ marginTop: 18 }}>
              <Field label="Restore from backup file" hint="Replaces the books on this device after the passphrase is verified.">
                <input type="file" accept=".kitabu,application/octet-stream" onChange={(e) => setRestoreFile(e.target.files?.[0] ?? null)} />
              </Field>
              <Field label="Backup passphrase">
                <input type="password" value={restorePass} onChange={(e) => setRestorePass(e.target.value)} autoComplete="off" />
              </Field>
              <div className="form-row" style={{ gridColumn: '1 / -1' }}>
                <button className="btn-danger" type="submit" disabled={restoring || restoreFile === null || restorePass === ''}>
                  {restoring ? 'Restoring…' : 'Restore books from backup'}
                </button>
              </div>
            </form>
          </>
        ) : (
          <p className="field-hint">Only the owner can export or restore backups.</p>
        )}
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
