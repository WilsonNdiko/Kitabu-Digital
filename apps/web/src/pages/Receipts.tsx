import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { api, type ReceiptItem } from '../api.ts';
import { Card, Empty, ErrorBanner, Spinner } from '../components.tsx';
import { dateKe, ksh } from '../format.ts';

/** Receipts (UX.md screens 12–13): every receipt ever issued, none ever deleted. */
export default function Receipts() {
  const [items, setItems] = useState<ReceiptItem[] | null>(null);
  const [includeVoided, setIncludeVoided] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    try {
      setItems(await api<ReceiptItem[]>(`/api/receipts${includeVoided ? '?includeVoided=1' : ''}`));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load receipts.');
    }
  }, [includeVoided]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Receipts</h1>
          <p className="sub">Frozen when issued — tamper-evident, printable, never edited.</p>
        </div>
        <label className="field-hint" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={includeVoided}
            onChange={(e) => setIncludeVoided(e.target.checked)}
            style={{ width: 'auto' }}
          />
          Show voided
        </label>
      </div>

      {error !== null && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {items === null
        ? <Spinner />
        : items.length === 0
          ? <Empty>No receipts issued yet. Issue one from a verified payment.</Empty>
          : (
            <Card>
              <table>
                <thead><tr><th>Receipt</th><th>Tenant</th><th>Method</th><th className="num">Amount</th><th>Issued</th><th></th></tr></thead>
                <tbody>
                  {items.map((r) => (
                    <tr key={r.id} className="clickable" onClick={() => navigate(`/receipts/${r.id}`)}>
                      <td className="strong">{r.receipt_no}{r.voided_at !== null && <span className="chip chip-red" style={{ marginLeft: 8 }}>Voided</span>}</td>
                      <td>{r.tenantName}<span className="field-hint"> · {r.unitLabel}</span></td>
                      <td>{methodName(r.method)}</td>
                      <td className="num strong">{ksh(r.amountMinor)}</td>
                      <td>{dateKe(r.issued_at)}</td>
                      <td>▸</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
      <p className="field-hint">
        Numbered in blocks per device — <Link to="/settings">Settings</Link> shows how many numbers remain.
      </p>
    </>
  );
}

function methodName(m: string): string {
  if (m === 'MPESA') return 'M-Pesa';
  if (m === 'CASH') return 'Cash';
  if (m === 'BANK') return 'Bank';
  return m;
}
