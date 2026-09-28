import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

export default function SettingsPage({ meRole }: { meRole?: string }) {
  const [sig, setSig] = useState<{ hasSignature: boolean; dataUrl: string | null }>({ hasSignature: false, dataUrl: null });
  const [msg, setMsg] = useState(''); const [err, setErr] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () => api.get('/signature').then(setSig).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  const upload = (file: File) => {
    setErr(''); setMsg('');
    if (file.size > 280_000) { setErr('That image is too large. Use a smaller photo (under ~280 KB).'); return; }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        await api.post('/signature', { dataUrl: reader.result as string });
        setMsg('Signature saved. It will appear on every receipt issued from now on.');
        load();
      } catch (e: any) { setErr(e.message); }
    };
    reader.readAsDataURL(file);
  };

  return (
    <>
      <h1>Settings</h1>
      <p className="sub">Your receipt signature and other preferences.</p>
      {err && <div className="alert error" style={{ marginBottom: 12 }}>{err}</div>}
      {msg && <div className="alert info" style={{ marginBottom: 12 }}>{msg}</div>}

      <div className="card" style={{ maxWidth: 560 }}>
        <h3 style={{ marginTop: 0 }}>Receipt signature</h3>
        <p className="sub">
          A photo of your signature (or rubber stamp) printed on every receipt. Receipts already issued keep
          the signature they were issued with — changing it never alters past receipts.
        </p>
        {sig.dataUrl ? (
          <div style={{ background: '#fff', border: '1px solid #e2e2e2', borderRadius: 8, padding: 12, marginBottom: 12, textAlign: 'center' }}>
            <img src={sig.dataUrl} alt="Current signature" style={{ maxHeight: 90, maxWidth: '100%' }} />
          </div>
        ) : (
          <div className="alert info" style={{ marginBottom: 12 }}>No signature yet — receipts are issued without one.</div>
        )}
        {meRole === 'OWNER' ? (
          <>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg" style={{ display: 'none' }}
              onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
            <button className="btn" onClick={() => fileRef.current?.click()}>
              {sig.hasSignature ? 'Replace signature' : 'Upload signature'}
            </button>
            <span className="sub" style={{ marginLeft: 10 }}>PNG or JPG, ideally on white background.</span>
          </>
        ) : (
          <p className="sub">Only the owner can change the signature.</p>
        )}
      </div>
    </>
  );
}
