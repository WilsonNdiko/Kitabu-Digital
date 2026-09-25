import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { api, type ReceiptDetail } from '../api.ts';
import { useApp } from '../App.tsx';
import { Chip, ErrorBanner, Spinner, SuccessBanner } from '../components.tsx';
import { dateKe, ksh, monthLabel } from '../format.ts';

/**
 * Receipt detail (UX.md screen 13): the receipt itself, assembled from frozen
 * system data — print or share it as PDF (browser print), verify its integrity.
 */
export default function ReceiptDetail() {
  const { id } = useParams();
  const { isOwner } = useApp();
  const [data, setData] = useState<ReceiptDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    if (id === undefined) return;
    try {
      setData(await api<ReceiptDetail>(`/api/receipts/${id}`));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this receipt.');
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (data === null) {
    return <>{error !== null && <ErrorBanner message={error} />}<Spinner /></>;
  }

  const { receipt, snapshot, integrity } = data;

  async function voidReceipt(): Promise<void> {
    if (!window.confirm(
      `Void receipt ${snapshot.receiptNo}?\n\nThe number is never reused. The payment stays verified — if the amount was wrong, reverse the payment instead (Payments screen).`,
    )) return;
    const reason = window.prompt('Reason for voiding (kept in the audit trail):');
    if (reason === null) return;
    try {
      await api(`/api/receipts/${receipt.id}/void`, { body: { reason } });
      setNotice('Receipt voided. It stays visible in history with its reason.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not void the receipt.');
    }
  }

  async function reissue(): Promise<void> {
    const reason = window.prompt(`Reissue receipt ${snapshot.receiptNo} — the old number is voided and a fresh number is issued for the same payment. Reason:`);
    if (reason === null) return;
    try {
      const result = await api<{ receipt: { id: string } }>(`/api/receipts/${receipt.id}/reissue`, { body: { reason } });
      navigate(`/receipts/${result.receipt.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reissue the receipt.');
    }
  }

  return (
    <>
      <div className="page-head no-print">
        <div>
          <h1>Receipt {snapshot.receiptNo}</h1>
          <p className="sub">Issued {dateKe(snapshot.issuedAt)} by {snapshot.issuedBy} on {snapshot.deviceName}</p>
        </div>
        <div className="card-actions">
          <button onClick={() => window.print()}>🖨 Print / save PDF</button>
          {isOwner && receipt.voided_at === null && (
            <>
              <button className="btn-danger" onClick={() => voidReceipt()}>Void</button>
              <button onClick={() => void reissue()}>Reissue</button>
            </>
          )}
        </div>
      </div>

      {error !== null && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {notice !== null && <SuccessBanner>{notice}</SuccessBanner>}

      <div className="receipt">
        {receipt.voided_at !== null && <div className="r-void">VOIDED — {receipt.void_reason}</div>}
        <div className="r-head">
          <div className="r-org">{snapshot.orgName}</div>
          <div className="r-sub">{snapshot.landlordName !== null ? `${snapshot.landlordName} · ` : ''}{snapshot.propertyName}{snapshot.propertyLocation !== '' ? `, ${snapshot.propertyLocation}` : ''}</div>
          {snapshot.kraPin !== null && <div className="r-sub">KRA PIN {snapshot.kraPin}</div>}
        </div>
        <div className="r-no"><span>OFFICIAL RECEIPT</span><span>No. {snapshot.receiptNo}</span></div>
        <dl>
          <dt>Received from</dt><dd>{snapshot.tenantName}</dd>
          <dt>House</dt><dd>{snapshot.unitLabel}</dd>
          <dt>Date paid</dt><dd>{dateKe(snapshot.paidAt)}</dd>
          <dt>Payment method</dt><dd>{methodName(snapshot.method)}{snapshot.reference !== null ? ` · ${snapshot.reference}` : ''}</dd>
          {snapshot.periods.length > 0 && (
            <><dt>Being payment for</dt><dd>{snapshot.periods.map((p) => monthLabel(p)).join(', ')}</dd></>
          )}
        </dl>
        <div className="r-amount">
          <div className="n">{ksh(snapshot.amountMinor)}</div>
          <div className="w">{snapshot.amountWords}</div>
        </div>
        <dl>
          <dt>Balance before</dt><dd>{ksh(snapshot.previousBalanceMinor)}</dd>
          <dt>Balance after</dt><dd>{ksh(snapshot.remainingBalanceMinor)}</dd>
        </dl>
        <div className="r-sign">
          <div className="sig">
            {snapshot.signatureLabel !== null ? `✍ ${snapshot.signatureLabel}` : 'Signed'}
            <br />{snapshot.landlordName ?? snapshot.orgName}
          </div>
          <div className="sig" style={{ textAlign: 'right' }}>
            Issued {dateKe(snapshot.issuedAt)}
            <br />{snapshot.receiptNo}
          </div>
        </div>
        <div className="r-foot">
          This receipt was issued by Kitabu from your rent book and is tamper-evident.
          <br />Digest {receipt.digest.slice(0, 16)}…
        </div>
      </div>

      <div className="integrity no-print">
        {integrity.ok && integrity.signatureValid === true
          ? <Chip tone="green">✓ Integrity verified — digest and digital signature match</Chip>
          : integrity.ok
            ? <Chip tone="green">✓ Integrity verified — digest matches</Chip>
            : <Chip tone="red">✗ Tamper check FAILED — this receipt's data does not match its seal</Chip>}
        {receipt.crypto_signature !== null
          ? <p className="field-hint">Signed with this organization's Ed25519 key — verifiable on any paired device.</p>
          : <p className="field-hint">Digitally signed when the organization key is present.</p>}
      </div>
    </>
  );
}

function methodName(m: string): string {
  if (m === 'MPESA') return 'M-Pesa';
  if (m === 'CASH') return 'Cash';
  if (m === 'BANK') return 'Bank';
  return m;
}
