import { useState } from 'react';

import { api, type OrgState } from '../api.ts';
import { Card, ErrorBanner, Field } from '../components.tsx';

/**
 * First run (UX.md screen 1): name the business, name the device — and the books
 * open. Everything works offline from this moment on.
 */
export default function Onboarding({ onDone }: { onDone: () => Promise<void> }) {
  const [organizationName, setOrganizationName] = useState('');
  const [landlordName, setLandlordName] = useState('');
  const [kraPin, setKraPin] = useState('');
  const [phone, setPhone] = useState('');
  const [unitTerm, setUnitTerm] = useState('House');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api<OrgState>('/api/bootstrap', {
        body: {
          organizationName,
          landlordName: landlordName === '' ? undefined : landlordName,
          kraPin: kraPin === '' ? undefined : kraPin,
          phone: phone === '' ? undefined : phone,
          unitTerm,
          deviceName: 'This device',
          platform: 'WINDOWS',
        },
      });
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup did not complete. Nothing was saved.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shell-center">
      <div style={{ maxWidth: 480, width: '100%' }}>
        <div style={{ textAlign: 'center', marginBottom: 18 }}>
          <div style={{ fontSize: 44 }}>📘</div>
          <h1>Karibu Kitabu</h1>
          <p style={{ color: 'var(--ink-soft)' }}>
            Your rent book — houses, tenants, payments and receipts — kept properly.
          </p>
        </div>
        <Card>
          {error !== null && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
          <form onSubmit={(e) => void submit(e)} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Field label="Organization name">
              <input value={organizationName} onChange={(e) => setOrganizationName(e.target.value)} placeholder="e.g. Wilson Properties" required autoFocus />
            </Field>
            <Field label="Landlord's name">
              <input value={landlordName} onChange={(e) => setLandlordName(e.target.value)} placeholder="e.g. Wilson Ndiko" />
            </Field>
            <div className="form-grid">
              <Field label="KRA PIN (optional)">
                <input value={kraPin} onChange={(e) => setKraPin(e.target.value)} placeholder="A051234567X" />
              </Field>
              <Field label="Phone (optional)">
                <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0722 123 456" />
              </Field>
            </div>
            <Field label="What do you call a rental unit?">
              <select value={unitTerm} onChange={(e) => setUnitTerm(e.target.value)}>
                <option>House</option>
                <option>Unit</option>
                <option>Room</option>
                <option>Apartment</option>
              </select>
            </Field>
            <button className="btn-primary" type="submit" disabled={busy || organizationName.trim() === ''}>
              {busy ? 'Setting up…' : 'Open my rent book'}
            </button>
            <p className="field-hint" style={{ textAlign: 'center' }}>
              Works fully offline — your books stay on this device. You can add more devices later.
            </p>
          </form>
        </Card>
      </div>
    </div>
  );
}
