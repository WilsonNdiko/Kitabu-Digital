import { useEffect, useRef, useState } from 'react';
import { api, ksh } from '../api';

export default function MpesaPage() {
  const [status, setStatus] = useState<{ lines: number; lastImportAt: string | null } | null>(null);
  const [queue, setQueue] = useState<any[]>([]);
  const [summary, setSummary] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () => Promise.all([
    api.get('/mpesa/status').then(setStatus),
    api.get('/mpesa/queue').then(setQueue),
  ]).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  const importFile = async (file: File) => {
    setErr(''); setSummary(null); setBusy(true);
    try {
      const csvText = await file.text();
      setSummary(await api.post('/mpesa/statement', { csvText }));
      await load();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const verify = async (p: any) => {
    try { await api.post(`/payments/${p.id}/verify`); await load(); } catch (e: any) { setErr(e.message); }
  };
  const reject = async (p: any) => {
    const reason = prompt(`Why are you rejecting this ${ksh(p.amount_minor)} payment from ${p.tenant_name}?`);
    if (!reason) return;
    try { await api.post(`/payments/${p.id}/reject`, { reason }); await load(); } catch (e: any) { setErr(e.message); }
  };

  const matchChip = (p: any) => {
    if (p.statement_minor == null) return <span className="chip neutral">Not on statement yet</span>;
    if (p.statement_minor === p.amount_minor) return <span className="chip ok">On statement ✓</span>;
    return <span className="chip bad">Amount differs: statement says {ksh(p.statement_minor)}</span>;
  };

  return (
    <>
      <h1>M-Pesa Check</h1>
      <p className="sub">
        Kitabu never moves money — tenants pay you directly. Here you import your own M-Pesa statement
        (CSV) and Kitabu confirms the codes your staff recorded really landed, with the right amounts.
      </p>
      {err && <div className="alert error" style={{ marginBottom: 12 }}>{err}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>Import statement</h3>
        <p className="sub">
          In the M-Pesa app: <b>M-PESA → Statements → Export (CSV)</b>, then pick that file here. A simple
          sheet with <b>Code</b> and <b>Amount</b> columns works too. Payments whose code and amount match
          are verified automatically; anything that differs is flagged for you — never auto-resolved.
        </p>
        <input ref={fileRef} type="file" accept=".csv,text/csv" style={{ display: 'none' }}
          onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
        <button className="btn" disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? 'Checking…' : '⬆ Import M-Pesa statement (CSV)'}
        </button>
        {status && (
          <span className="sub" style={{ marginLeft: 12 }}>
            {status.lines} statement line{status.lines === 1 ? '' : 's'} known
            {status.lastImportAt ? ` · last import ${new Date(status.lastImportAt).toLocaleString()}` : ''}
          </span>
        )}
        {summary && (
          <div className="alert info" style={{ marginTop: 12 }}>
            Read {summary.parsedLines} incoming payment{summary.parsedLines === 1 ? '' : 's'} ({summary.newLines} new).{' '}
            <b>{summary.autoVerified} verified automatically.</b>{' '}
            {summary.mismatches.length > 0 && <>⚠️ {summary.mismatches.length} amount mismatch{summary.mismatches.length === 1 ? '' : 'es'} need your review below.{' '}</>}
            {summary.stillUnmatched > 0 && <>{summary.stillUnmatched} recorded code{summary.stillUnmatched === 1 ? ' is' : 's are'} not on this statement (maybe a newer period).</>}
          </div>
        )}
      </div>

      <h3>Waiting for verification</h3>
      {queue.length === 0 ? (
        <div className="alert info">No M-Pesa payments waiting. 🎉</div>
      ) : (
        <table className="table">
          <thead><tr><th>Tenant</th><th>House</th><th>Date</th><th className="num">Recorded</th><th>Code</th><th>Statement says</th><th></th></tr></thead>
          <tbody>
            {queue.map((p) => (
              <tr key={p.id}>
                <td style={{ fontWeight: 600 }}>{p.tenant_name}</td>
                <td>{p.unit_label}</td>
                <td>{p.payment_date}</td>
                <td className="num">{ksh(p.amount_minor)}</td>
                <td><code>{p.reference}</code></td>
                <td>{matchChip(p)}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn small" onClick={() => verify(p)}>Verify</button>{' '}
                  <button className="btn small danger" onClick={() => reject(p)}>Reject</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="alert info" style={{ marginTop: 14 }}>
        A matching code on your statement is proof the money reached <i>your</i> M-Pesa. Codes not on the
        statement yet may simply be from after the export date — import a fresh statement to check them.
      </div>
    </>
  );
}
