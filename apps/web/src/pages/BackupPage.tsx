import { useEffect, useState } from 'react';
import { api } from '../api';

export default function BackupPage({ meRole }: { meRole?: string }) {
  const [lastBackupAt, setLastBackupAt] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(''); const [err, setErr] = useState('');

  useEffect(() => { api.get('/backup/status').then((s) => setLastBackupAt(s.lastBackupAt)).catch(() => {}); }, []);

  const download = async () => {
    setErr(''); setMsg('');
    if (passphrase.length < 6) { setErr('Choose a passphrase of at least 6 characters.'); return; }
    if (passphrase !== confirm) { setErr('The two passphrases do not match.'); return; }
    setBusy(true);
    try {
      const blob = await api.postBlob('/backup', { passphrase });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `kitabu-backup-${new Date().toISOString().slice(0, 10)}.kdb`;
      a.click();
      URL.revokeObjectURL(url);
      setMsg('Backup downloaded. Keep the file AND the passphrase somewhere safe — a flash disk, email to yourself, or Google Drive.');
      setPassphrase(''); setConfirm('');
      api.get('/backup/status').then((s) => setLastBackupAt(s.lastBackupAt)).catch(() => {});
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  if (meRole !== 'OWNER') {
    return (<><h1>Backup</h1><div className="alert info">Only the owner can create backups.</div></>);
  }

  return (
    <>
      <h1>Backup</h1>
      <p className="sub">
        A backup is one encrypted file containing everything — properties, tenants, payments, receipts.
        Without your passphrase the file is unreadable, so it is safe on a flash disk or in email.
      </p>
      {err && <div className="alert error" style={{ marginBottom: 12 }}>{err}</div>}
      {msg && <div className="alert info" style={{ marginBottom: 12 }}>{msg}</div>}

      <div className="card form" style={{ maxWidth: 480 }}>
        <div className="field">
          <label>Backup passphrase</label>
          <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder="At least 6 characters" />
        </div>
        <div className="field">
          <label>Repeat passphrase</label>
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        <div className="alert error" style={{ fontSize: 13 }}>
          ⚠️ If you forget this passphrase, the backup CANNOT be opened by anyone — not even us. Write it down.
        </div>
        <button className="btn" disabled={busy} onClick={download}>{busy ? 'Preparing…' : '⬇ Download encrypted backup'}</button>
        <p className="sub" style={{ margin: 0 }}>
          Last backup: {lastBackupAt ? new Date(lastBackupAt).toLocaleString() : 'never'}
        </p>
      </div>

      <div className="card" style={{ maxWidth: 480, marginTop: 14 }}>
        <h3 style={{ marginTop: 0 }}>Restoring</h3>
        <p className="sub" style={{ marginBottom: 0 }}>
          On a new or wiped device, open Kitabu and choose <b>“Restore from a backup”</b> on the welcome screen,
          then pick this file and enter the passphrase. Everything comes back — receipt numbers included.
        </p>
      </div>
    </>
  );
}
