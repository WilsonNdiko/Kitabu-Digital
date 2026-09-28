import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ksh } from '../api';

export default function Receipts() {
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => { api.get('/receipts').then(setRows).catch(() => {}); }, []);

  return (
    <>
      <h1>Receipts</h1>
      <p className="sub">Every receipt is immutable — exactly as issued, forever.</p>
      {rows.length === 0 ? (
        <div className="empty"><div className="big-emoji">🧾</div>No receipts yet. Receipts appear when payments are verified.</div>
      ) : (
        <table className="table">
          <thead><tr><th>Receipt No.</th><th>Tenant</th><th>House</th><th className="num">Amount</th><th>Issued</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td><Link to={`/receipts/${r.id}`} style={{ fontWeight: 700 }}>{r.receipt_no}</Link></td>
                <td>{r.snapshot.tenantName}</td>
                <td>{r.snapshot.unitLabel}</td>
                <td className="num">{ksh(r.snapshot.amountMinor)}</td>
                <td>{r.issued_at.slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
