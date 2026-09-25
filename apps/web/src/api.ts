/**
 * API client — one fetch wrapper for the whole app.
 * Errors surface the core's friendly messages (docs/UX.md §5); nothing technical
 * ever reaches the landlord.
 */

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const ACTING_KEY = 'kitabu.actingUser';

export function actingUserHeader(): string | null {
  return localStorage.getItem(ACTING_KEY);
}

export function setActingUser(userId: string): void {
  localStorage.setItem(ACTING_KEY, userId);
}

export interface ApiOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
}

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const acting = actingUserHeader();
  if (acting !== null) headers['x-acting-user'] = acting;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, {
    method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    // non-JSON response — fall through to generic handling
  }
  if (!res.ok) {
    const err = payload as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(
      res.status,
      err?.error?.code ?? 'NETWORK',
      err?.error?.message ?? 'Kitabu could not reach this device\'s books. Check the connection and try again.',
    );
  }
  return payload as T;
}

// -- shared payload types (snake_case rows, as the core returns them) ----------------

export interface UserRow {
  id: string;
  full_name: string;
  phone: string | null;
  role: 'OWNER' | 'MANAGER' | 'CARETAKER';
  is_active: 0 | 1;
}

export interface OrgState {
  bootstrapped: boolean;
  org?: {
    name: string;
    landlordName: string | null;
    kraPin: string | null;
    phone: string | null;
    unitTerm: string;
    currency: string;
  };
  device?: { name: string; platform: string };
  users?: UserRow[];
  actingUserId?: string | null;
  today?: string;
}

export interface PropertyWithCounts {
  id: string;
  name: string;
  town: string | null;
  estate: string | null;
  unit_count: number;
  occupied_count: number;
  summary?: {
    totalUnits: number;
    occupied: number;
    vacant: number;
    maintenance: number;
  };
  collection?: { month: string; expectedMinor: number; collectedMinor: number; rate: number | null };
}

export interface UnitRow {
  id: string;
  property_id: string;
  label: string;
  status: 'VACANT' | 'OCCUPIED' | 'RESERVED' | 'MAINTENANCE';
}

export interface TenantRow {
  id: string;
  full_name: string;
  phone: string | null;
  id_number: string | null;
  notes: string | null;
}

export interface TenancyRow {
  id: string;
  tenant_id: string;
  unit_id: string;
  property_id: string;
  start_date: string;
  end_date: string | null;
  expected_payment_day: number;
  deposit_amount_minor: number;
  deposit_paid: 0 | 1;
  current_rent_minor: number;
  status: 'ACTIVE' | 'ENDED';
}

export interface TenantListItem {
  tenant: TenantRow;
  tenancy: TenancyRow | null;
  unitLabel: string | null;
  propertyName: string | null;
  balanceMinor: number | null;
}

export interface LedgerLine {
  id: string;
  entry_date: string;
  entry_type: 'CHARGE' | 'PAYMENT_CREDIT' | 'ADJUSTMENT' | 'REVERSAL';
  direction: 'DEBIT' | 'CREDIT';
  amount_minor: number;
  kind: string;
  period: string | null;
  reason: string | null;
  note: string | null;
  balance_after_minor: number;
}

export interface MonthStatusRow {
  month: string;
  chargeMinor: number;
  paidMinor: number;
  status: 'UNPAID' | 'PARTIAL' | 'PAID' | 'NO_CHARGE';
}

export interface TenantDetail {
  tenant: TenantRow;
  history: Array<TenancyRow & { unit_label: string }>;
  active: {
    tenancy: TenancyRow;
    unitLabel: string;
    propertyName: string;
    balanceMinor: number;
    statement: { entries: LedgerLine[]; balanceMinor: number };
    months: MonthStatusRow[];
    payments: PaymentItem[];
  } | null;
}

export interface PaymentItem {
  id: string;
  tenancy_id: string;
  amount_minor: number;
  method: 'CASH' | 'MPESA' | 'BANK' | 'OTHER';
  paid_at: string;
  reference: string | null;
  status: 'PENDING' | 'VERIFYING' | 'VERIFIED' | 'REJECTED' | 'REVERSED';
  reversal_reason: string | null;
  verification_note: string | null;
  tenantName: string;
  unitLabel: string;
  propertyName: string;
  hasReceipt: boolean;
}

export interface ReceiptItem {
  id: string;
  receipt_no: string;
  issued_at: string;
  voided_at: string | null;
  void_reason: string | null;
  tenantName: string;
  unitLabel: string;
  propertyName: string;
  amountMinor: number;
  amountWords: string;
  method: string;
}

export interface ReceiptDetail {
  receipt: {
    id: string;
    receipt_no: string;
    voided_at: string | null;
    void_reason: string | null;
    digest: string;
    crypto_signature: string | null;
  };
  snapshot: {
    receiptNo: string;
    issuedAt: string;
    orgName: string;
    landlordName: string | null;
    kraPin: string | null;
    propertyName: string;
    propertyLocation: string;
    tenantName: string;
    unitLabel: string;
    amountMinor: number;
    amountWords: string;
    paidAt: string;
    method: string;
    reference: string | null;
    periods: string[];
    previousBalanceMinor: number;
    remainingBalanceMinor: number;
    signatureLabel: string | null;
    issuedBy: string;
    deviceName: string;
  };
  integrity: { ok: boolean; digestMatches: boolean; signatureValid: boolean | null };
}

export interface AuditRow {
  id: string;
  action: string;
  entity_type: string;
  summary: string;
  created_at: string;
  actor_user_id: string | null;
}

export interface DashboardData {
  month: string;
  properties: PropertyWithCounts[];
  totals: { properties: number; units: number; occupied: number };
  collection: { month: string; expectedMinor: number; collectedMinor: number; rate: number | null };
  arrearsTotalMinor: number;
  arrears: Array<{
    tenancyId: string;
    tenantName: string;
    unitLabel: string;
    propertyName: string;
    balanceMinor: number;
    lastPaymentAt: string | null;
  }>;
  monthOverview: Array<MonthStatusRow & { tenancyId: string; tenantId: string; tenantName: string; unitLabel: string; rentMinor: number }>;
  pendingCount: number;
  recentAudit: AuditRow[];
}
