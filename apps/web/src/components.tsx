import { type ReactNode } from 'react';

/** Status chips — the app's colour language (UX.md §6). */

export function Chip({ tone, children }: { tone: 'green' | 'amber' | 'red' | 'gray' | 'blue'; children: ReactNode }) {
  return <span className={`chip chip-${tone}`}>{children}</span>;
}

export function paymentStatusChip(status: string): JSX.Element {
  switch (status) {
    case 'VERIFIED': return <Chip tone="green">Verified</Chip>;
    case 'PENDING': return <Chip tone="amber">Pending</Chip>;
    case 'VERIFYING': return <Chip tone="amber">Checking…</Chip>;
    case 'REJECTED': return <Chip tone="red">Rejected</Chip>;
    case 'REVERSED': return <Chip tone="gray">Reversed</Chip>;
    default: return <Chip tone="gray">{status}</Chip>;
  }
}

export function monthStatusChip(status: string): JSX.Element {
  switch (status) {
    case 'PAID': return <Chip tone="green">Paid</Chip>;
    case 'PARTIAL': return <Chip tone="amber">Partial</Chip>;
    case 'UNPAID': return <Chip tone="red">Unpaid</Chip>;
    default: return <Chip tone="gray">—</Chip>;
  }
}

export function balanceChip(balanceMinor: number | null): JSX.Element {
  if (balanceMinor === null) return <Chip tone="gray">No house</Chip>;
  if (balanceMinor > 0) return <Chip tone="red">Owes {fmt(balanceMinor)}</Chip>;
  if (balanceMinor < 0) return <Chip tone="blue">Advance {fmt(-balanceMinor)}</Chip>;
  return <Chip tone="green">Settled</Chip>;
}

function fmt(minor: number): string {
  const shillings = Math.abs(minor) / 100;
  return `KSh ${shillings.toLocaleString('en-KE')}`;
}

/** A friendly inline error banner — carries the core's own message. */
export function ErrorBanner({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  return (
    <div className="banner banner-error" role="alert">
      <span>⚠️ {message}</span>
      {onDismiss !== undefined && <button className="banner-close" onClick={onDismiss} aria-label="Dismiss">✕</button>}
    </div>
  );
}

export function SuccessBanner({ children }: { children: ReactNode }) {
  return <div className="banner banner-success" role="status">✓ {children}</div>;
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card${className !== undefined ? ` ${className}` : ''}`}>
      {(title !== undefined || actions !== undefined) && (
        <div className="card-head">
          {title !== undefined && <h2>{title}</h2>}
          {actions !== undefined && <div className="card-actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function Spinner() {
  return <p className="empty">Loading…</p>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint !== undefined && <span className="field-hint">{hint}</span>}
    </label>
  );
}

/** Destructive/rare actions always confirm in plain language (UX.md §4). */
export function confirmAction(message: string): boolean {
  return window.confirm(message);
}

export function promptReason(action: string): string | null {
  const reason = window.prompt(`${action} — give a reason (kept in the audit trail):`);
  return reason === null ? null : reason.trim();
}
