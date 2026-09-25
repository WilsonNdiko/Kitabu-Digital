import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api, type PropertyWithCounts, type TenantListItem } from '../api.ts';
import { useApp } from '../App.tsx';
import { Card, Empty, ErrorBanner, Field, Spinner, balanceChip } from '../components.tsx';
import { parseKsh, phoneKe } from '../format.ts';

/** Tenants list (UX.md screen 6): search-first. */
export default function Tenants() {
  const [items, setItems] = useState<TenantListItem[] | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const navigate = useNavigate();
  const { isOwner, actingUser } = useApp();

  const load = useCallback(async (q: string) => {
    try {
      const path = q.trim() === '' ? '/api/tenants' : `/api/tenants?search=${encodeURIComponent(q)}`;
      setItems(await api<TenantListItem[]>(path));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load tenants.');
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void load(search), 180);
    return () => clearTimeout(t);
  }, [search, load]);

  const canPlaceTenants = isOwner;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Tenants</h1>
          <p className="sub">Find anyone by name, phone or house.</p>
        </div>
        <button className="btn-primary" onClick={() => setAdding((v) => !v)}>＋ Add tenant</button>
      </div>

      {error !== null && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search name, phone or house…"
        aria-label="Search tenants"
        style={{ marginBottom: 14 }}
      />

      {adding && (
        <AddTenantCard
          canPlace={canPlaceTenants}
          onDone={async () => {
            setAdding(false);
            await load(search);
          }}
          onCancel={() => setAdding(false)}
        />
      )}

      {items === null
        ? <Spinner />
        : items.length === 0
          ? <Empty>No tenants found.{search !== '' ? ' Try another spelling or phone number.' : ''}</Empty>
          : (
            <Card>
              <table>
                <thead><tr><th>Tenant</th><th>Phone</th><th>House</th><th>Status</th></tr></thead>
                <tbody>
                  {items.map((t) => (
                    <tr key={t.tenant.id} className="clickable" onClick={() => navigate(`/tenants/${t.tenant.id}`)}>
                      <td className="strong">{t.tenant.full_name}</td>
                      <td>{phoneKe(t.tenant.phone)}</td>
                      <td>{t.unitLabel !== null ? `${t.unitLabel} · ${t.propertyName}` : '—'}</td>
                      <td>{balanceChip(t.balanceMinor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
      {actingUser !== null && !isOwner && (
        <p className="field-hint">As a {actingUser.role.toLowerCase()} you can register tenants and record payments; placing tenants in houses is done by the owner.</p>
      )}
    </>
  );
}

function AddTenantCard({ canPlace, onDone, onCancel }: { canPlace: boolean; onDone: () => Promise<void>; onCancel: () => void }) {
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [idNumber, setIdNumber] = useState('');
  const [unitId, setUnitId] = useState('');
  const [rent, setRent] = useState('');
  const [deposit, setDeposit] = useState('');
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [properties, setProperties] = useState<PropertyWithCounts[]>([]);
  const [units, setUnits] = useState<Array<{ id: string; label: string; status: string; propertyId: string }>>([]);

  useEffect(() => {
    void (async () => {
      try {
        const props = await api<PropertyWithCounts[]>('/api/properties');
        setProperties(props);
        const allUnits: Array<{ id: string; label: string; status: string; propertyId: string }> = [];
        for (const p of props) {
          const d = await api<{ units: Array<{ id: string; label: string; status: string }> }>(`/api/properties/${p.id}`);
          for (const u of d.units) allUnits.push({ ...u, propertyId: p.id });
        }
        setUnits(allUnits);
      } catch {
        // property load failures surface on submit
      }
    })();
  }, []);

  const vacant = units.filter((u) => u.status === 'VACANT');

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { tenant } = await api<{ tenant: { id: string } }>('/api/tenants', {
        body: {
          fullName,
          phone: phone === '' ? undefined : phone,
          idNumber: idNumber === '' ? undefined : idNumber,
        },
      });
      if (canPlace && unitId !== '') {
        const rentMinor = parseKsh(rent);
        if (rentMinor === null) throw new Error('Enter the monthly rent, for example 12000.');
        await api(`/api/tenants/${tenant.id}/tenancy`, {
          body: {
            unitId,
            rentMinor,
            depositMinor: deposit.trim() === '' ? undefined : parseKsh(deposit) ?? undefined,
            startDate,
          },
        });
      }
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not register the tenant.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="New tenant">
      {error !== null && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <form onSubmit={(e) => void submit(e)} className="form-grid">
        <Field label="Full name"><input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="John Kamau" required autoFocus /></Field>
        <Field label="Phone"><input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0712 345 678" /></Field>
        <Field label="ID number (optional)"><input value={idNumber} onChange={(e) => setIdNumber(e.target.value)} /></Field>
        {canPlace && (
          <>
            <Field label="House (vacant only)" hint={vacant.length === 0 ? 'No vacant houses — end a tenancy first.' : undefined}>
              <select value={unitId} onChange={(e) => setUnitId(e.target.value)}>
                <option value="">— not placed yet —</option>
                {vacant.map((u) => {
                  const p = properties.find((pp) => pp.id === u.propertyId);
                  return <option key={u.id} value={u.id}>{u.label} · {p?.name ?? ''}</option>;
                })}
              </select>
            </Field>
            <Field label="Monthly rent (KSh)"><input value={rent} onChange={(e) => setRent(e.target.value)} placeholder="12000" inputMode="decimal" disabled={unitId === ''} /></Field>
            <Field label="Deposit (KSh, optional)"><input value={deposit} onChange={(e) => setDeposit(e.target.value)} placeholder="24000" inputMode="decimal" disabled={unitId === ''} /></Field>
            <Field label="Move-in date"><input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} disabled={unitId === ''} /></Field>
          </>
        )}
        <div className="form-row" style={{ gridColumn: '1 / -1' }}>
          <button className="btn-primary" type="submit" disabled={busy || fullName.trim() === ''}>{busy ? 'Saving…' : 'Register tenant'}</button>
          <button type="button" className="btn-quiet" onClick={onCancel}>Cancel</button>
        </div>
      </form>
    </Card>
  );
}
