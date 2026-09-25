import { useCallback, useEffect, useState } from 'react';

import { api, type PropertyWithCounts, type UnitRow } from '../api.ts';
import { useApp } from '../App.tsx';
import { Card, Chip, Empty, ErrorBanner, Field, Spinner, SuccessBanner } from '../components.tsx';
import { ksh, monthLabel } from '../format.ts';

interface PropertyDetailData {
  property: PropertyWithCounts;
  units: Array<UnitRow & { tenant_name?: string }>;
  summary: { totalUnits: number; occupied: number; vacant: number; maintenance: number };
  collection: { month: string; expectedMinor: number; collectedMinor: number; rate: number | null };
  arrears: Array<{ tenancyId: string; tenantName: string; unitLabel: string; balanceMinor: number }>;
}

/** Properties (UX.md screens 3–5): the portfolio at a glance. */
export default function Properties() {
  const { isOwner } = useApp();
  const [properties, setProperties] = useState<PropertyWithCounts[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [addingProperty, setAddingProperty] = useState(false);

  const load = useCallback(async () => {
    try {
      setProperties(await api<PropertyWithCounts[]>('/api/properties'));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load properties.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Properties</h1>
          <p className="sub">Your houses, who lives in them, and how each place is collecting.</p>
        </div>
        {isOwner && <button className="btn-primary" onClick={() => setAddingProperty((v) => !v)}>＋ Add property</button>}
      </div>

      {error !== null && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {notice !== null && <SuccessBanner>{notice}</SuccessBanner>}

      {addingProperty && (
        <AddPropertyCard
          onDone={async (name) => {
            setAddingProperty(false);
            setNotice(`Property "${name}" added.`);
            await load();
          }}
          onCancel={() => setAddingProperty(false)}
        />
      )}

      {properties === null
        ? <Spinner />
        : properties.length === 0
          ? <Empty>No properties yet. Add your first apartment block to start the books.</Empty>
          : properties.map((p) => <PropertyCard key={p.id} property={p} onChange={() => void load()} />)}
    </>
  );
}

function PropertyCard({ property, onChange }: { property: PropertyWithCounts; onChange: () => void }) {
  const { isOwner } = useApp();
  const [detail, setDetail] = useState<PropertyDetailData | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function toggle(): Promise<void> {
    if (open) {
      setOpen(false);
      return;
    }
    try {
      setDetail(await api<PropertyDetailData>(`/api/properties/${property.id}`));
      setOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this property.');
    }
  }

  const s = property.summary ?? { totalUnits: property.unit_count, occupied: property.occupied_count, vacant: property.unit_count - property.occupied_count, maintenance: 0, reserved: 0 };
  const vacant = Math.max(s.vacant, 0);

  return (
    <Card
      title={property.name}
      actions={<button className="btn-small" onClick={() => void toggle()}>{open ? 'Close' : 'Open'}</button>}
    >
      {error !== null && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {notice !== null && <SuccessBanner>{notice}</SuccessBanner>}
      <div className="stat" style={{ border: 'none', padding: 0, background: 'transparent' }}>
        <div className="sub">
          {[property.estate, property.town].filter((x) => x !== null && x !== '').join(', ') || '—'} ·{' '}
          {s.occupied} occupied · {vacant > 0 ? vacant : 0} vacant
          {property.collection?.rate !== null && property.collection !== undefined && (
            <> · collecting <strong>{Math.round((property.collection.rate ?? 0) * 100)}%</strong> this month</>
          )}
        </div>
      </div>

      {open && detail !== null && (
        <>
          <h3 style={{ marginTop: 14 }}>Houses</h3>
          {detail.units.length === 0
            ? <Empty>No houses recorded yet.</Empty>
            : (
              <table>
                <thead><tr><th>House</th><th>Status</th><th className="num">Owing</th></tr></thead>
                <tbody>
                  {detail.units.map((u) => {
                    const owing = detail.arrears.find((a) => a.unitLabel === u.label);
                    return (
                      <tr key={u.id}>
                        <td className="strong">{u.label}</td>
                        <td>
                          {u.status === 'OCCUPIED' ? <Chip tone="green">Occupied</Chip>
                            : u.status === 'MAINTENANCE' ? <Chip tone="amber">Maintenance</Chip>
                            : <Chip tone="gray">Vacant</Chip>}
                        </td>
                        <td className="num">{owing !== undefined ? ksh(owing.balanceMinor) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          {isOwner && (
            <AddHouseCard
              propertyId={property.id}
              onDone={async (label) => {
                setNotice(`House ${label} added.`);
                setDetail(await api<PropertyDetailData>(`/api/properties/${property.id}`));
                onChange();
              }}
            />
          )}
          <p className="field-hint">
            {monthLabel(detail.collection.month)}: collected {ksh(detail.collection.collectedMinor)} of {ksh(detail.collection.expectedMinor)} expected.
          </p>
        </>
      )}
    </Card>
  );
}

function AddPropertyCard({ onDone, onCancel }: { onDone: (name: string) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [town, setTown] = useState('');
  const [estate, setEstate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/api/properties', { body: { name, town: town === '' ? undefined : town, estate: estate === '' ? undefined : estate } });
      await onDone(name);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the property.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="New property">
      {error !== null && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <form onSubmit={(e) => void submit(e)} className="form-grid">
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Green View Apartments" required autoFocus /></Field>
        <Field label="Estate / area"><input value={estate} onChange={(e) => setEstate(e.target.value)} placeholder="Kasarani" /></Field>
        <Field label="Town"><input value={town} onChange={(e) => setTown(e.target.value)} placeholder="Nairobi" /></Field>
        <div className="form-row">
          <button className="btn-primary" type="submit" disabled={busy || name.trim() === ''}>{busy ? 'Adding…' : 'Add property'}</button>
          <button type="button" className="btn-quiet" onClick={onCancel}>Cancel</button>
        </div>
      </form>
    </Card>
  );
}

function AddHouseCard({ propertyId, onDone }: { propertyId: string; onDone: (label: string) => Promise<void> }) {
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/api/properties/${propertyId}/units`, { body: { label } });
      setLabel('');
      await onDone(label);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the house.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="form-row" style={{ marginTop: 12 }}>
      {error !== null && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <div style={{ flex: 1, minWidth: 160 }}>
        <Field label="Add a house">
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. B-06" />
        </Field>
      </div>
      <button className="btn-small" type="submit" disabled={busy || label.trim() === ''}>{busy ? 'Adding…' : 'Add house'}</button>
    </form>
  );
}
