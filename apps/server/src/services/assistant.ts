/**
 * "Ask Kitabu" — Phase 7a (docs/AI.md).
 *
 * The assistant is a convenience layer ON TOP of the same deterministic
 * services the UI uses. It is never the source of truth: every figure in an
 * answer is copied from a tool result, tools run under the signed-in user's
 * role (same RBAC as the routes), and nothing here writes to the database.
 *
 * This file implements the OFFLINE COMMAND PARSER of AI.md §4 — deterministic
 * patterns (English + common Swahili), no LLM, so it works on a matatu with
 * zero connectivity. A cloud LLM provider can later map richer language onto
 * the SAME tool registry; the tools and permissions do not change.
 */
import { formatKsh, periodOf } from '@kitabu/core';
import { type Ctx } from '../db/index.js';
import { todayIso } from '../db/index.js';
import { arrears, dashboard, listTenants, tenantDetail } from './queries.js';
import { collectionReport, expenseReport, occupancyReport } from './reports.js';
import { listMaintenance } from './operations.js';
import { verificationQueue } from './mpesa.js';

export interface AssistantReply {
  answer: string;                       // plain sentences, figures copied from tool output
  tool: string;                         // which deterministic tool produced the data
  data?: unknown;                       // structured rows for the UI to render
  suggestions?: string[];               // follow-up chips
}

const K = formatKsh;
const FINANCIAL_ROLES = new Set(['OWNER', 'MANAGER']);

// ----------------------------------------------------------- period words --
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];

/** "last month" | "in january" | "march 2026" → YYYY-MM (default: current). */
export function parsePeriod(q: string, today = todayIso()): string {
  const current = periodOf(today);
  const lower = q.toLowerCase();
  if (/last\s+month|mwezi\s+uliopita/.test(lower)) {
    const [y, m] = current.split('-').map(Number);
    const d = new Date(Date.UTC(y!, m! - 2, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  for (let i = 0; i < MONTHS.length; i++) {
    const name = MONTHS[i]!;
    const re = new RegExp(`\\b(${name}|${name.slice(0, 3)})\\b(\\s+(\\d{4}))?`, 'i');
    const m = lower.match(re);
    if (m) {
      const year = m[3] ? Number(m[3]) : Number(current.slice(0, 4));
      return `${year}-${String(i + 1).padStart(2, '0')}`;
    }
  }
  return current;
}

const monthLabel = (period: string) => {
  const [y, m] = period.split('-').map(Number);
  return `${MONTHS[m! - 1]![0]!.toUpperCase()}${MONTHS[m! - 1]!.slice(1)} ${y}`;
};

// ------------------------------------------------------------------ tools --
function toolArrears(ctx: Ctx, q: string): AssistantReply {
  const period = parsePeriod(q);
  const a = arrears(ctx, { period });
  const rows = (a.rows as any[]).sort((x, y) => y.balanceMinor - x.balanceMinor);
  if (!rows.length) {
    return { answer: `Good news — nobody owes anything as of ${monthLabel(period)}. 🎉`, tool: 'get_arrears', data: [] };
  }
  const top = rows.slice(0, 8);
  const lines = top.map((r) => `• ${r.tenantName} (${r.unitLabel}, ${r.propertyName}) — owes ${K(r.balanceMinor)}`);
  return {
    answer: `${rows.length} tenant${rows.length === 1 ? '' : 's'} owe a total of ${K(a.totalArrearsMinor)}:\n`
      + lines.join('\n') + (rows.length > top.length ? `\n…and ${rows.length - top.length} more (see Arrears).` : ''),
    tool: 'get_arrears', data: rows,
    suggestions: ['How much did I collect this month?', 'Which houses are vacant?'],
  };
}

function toolCollection(ctx: Ctx, q: string): AssistantReply {
  if (!FINANCIAL_ROLES.has(ctx.userRole)) {
    return { answer: 'Collection totals are only available to the owner and managers.', tool: 'get_collection' };
  }
  const period = parsePeriod(q);
  const r = collectionReport(ctx, period);
  return {
    answer: `In ${monthLabel(period)} you collected ${K(r.total.collectedMinor)} of ${K(r.total.expectedMinor)} expected `
      + `(${r.total.ratePct}%). Outstanding: ${K(r.total.outstandingMinor)}.`,
    tool: 'get_collection', data: r.properties,
    suggestions: ['Who has not paid?', 'What did I spend this month?'],
  };
}

function toolExpenses(ctx: Ctx, q: string): AssistantReply {
  if (!FINANCIAL_ROLES.has(ctx.userRole)) {
    return { answer: 'Expense totals are only available to the owner and managers.', tool: 'get_expense_summary' };
  }
  const period = parsePeriod(q);
  const r = expenseReport(ctx, `${period}-01`, `${period}-31`);
  if (!r.totalMinor) return { answer: `No expenses recorded in ${monthLabel(period)}.`, tool: 'get_expense_summary', data: [] };
  const lines = (r.byCategory as any[]).map((c) => `• ${c.category}: ${K(c.totalMinor)} (${c.count})`);
  return {
    answer: `You spent ${K(r.totalMinor)} in ${monthLabel(period)}:\n${lines.join('\n')}`,
    tool: 'get_expense_summary', data: r.byCategory,
  };
}

function toolVacant(ctx: Ctx): AssistantReply {
  const occ = occupancyReport(ctx) as any[];
  const vacant = occ.reduce((s, p) => s + (p.vacant ?? 0), 0);
  const total = occ.reduce((s, p) => s + (p.units ?? 0), 0);
  if (!vacant) return { answer: `All ${total} houses are occupied. 🎉`, tool: 'get_vacant_units', data: occ };
  const lines = occ.filter((p) => p.vacant > 0).map((p) => `• ${p.propertyName}: ${p.vacant} vacant of ${p.units}`);
  return {
    answer: `${vacant} of ${total} houses are vacant:\n${lines.join('\n')}`,
    tool: 'get_vacant_units', data: occ,
  };
}

function toolPending(ctx: Ctx): AssistantReply {
  if (!FINANCIAL_ROLES.has(ctx.userRole)) {
    return { answer: 'The verification queue is only available to the owner and managers.', tool: 'get_pending_verifications' };
  }
  const q = verificationQueue(ctx) as any[];
  if (!q.length) return { answer: 'No payments are waiting for verification.', tool: 'get_pending_verifications', data: [] };
  const total = q.reduce((s, p) => s + p.amount_minor, 0);
  const lines = q.slice(0, 6).map((p) =>
    `• ${p.tenant_name} (${p.unit_label}) — ${K(p.amount_minor)}, code ${p.reference ?? '—'}${p.statement_minor != null ? (p.statement_minor === p.amount_minor ? ' · on statement ✓' : ` · statement says ${K(p.statement_minor)} ⚠️`) : ''}`);
  return {
    answer: `${q.length} M-Pesa payment${q.length === 1 ? '' : 's'} (${K(total)}) waiting for verification:\n${lines.join('\n')}`,
    tool: 'get_pending_verifications', data: q,
    suggestions: ['Open M-Pesa Check'],
  };
}

function toolMaintenance(ctx: Ctx): AssistantReply {
  const open = listMaintenance(ctx, true) as any[];
  if (!open.length) return { answer: 'No open maintenance requests. 🎉', tool: 'get_open_maintenance', data: [] };
  const lines = open.slice(0, 8).map((m) => `• ${m.title} (${m.unit_label ?? m.property_name ?? ''}) — ${m.status}`);
  return {
    answer: `${open.length} open maintenance request${open.length === 1 ? '' : 's'}:\n${lines.join('\n')}`,
    tool: 'get_open_maintenance', data: open,
  };
}

function toolDashboard(ctx: Ctx): AssistantReply {
  const d = dashboard(ctx);
  const money = FINANCIAL_ROLES.has(ctx.userRole)
    ? ` Expected ${K(d.expectedMinor)}, collected ${K(d.collectedMinor)}, outstanding ${K(d.outstandingMinor)}.`
    : '';
  return {
    answer: `${monthLabel(d.period)}: ${d.occupied}/${d.units} houses occupied.${money} `
      + `${d.tenants.paid} paid, ${d.tenants.partial} partial, ${d.tenants.overdue} overdue. `
      + `${d.pendingVerification} payment${d.pendingVerification === 1 ? '' : 's'} pending verification, ${d.openMaintenance} open maintenance.`,
    tool: 'get_dashboard', data: d,
    suggestions: ['Who has not paid?', 'Which houses are vacant?'],
  };
}

function toolTenant(ctx: Ctx, tenant: any): AssistantReply {
  const d = tenantDetail(ctx, tenant.id)!;
  const unit = d.activeTenancy ? `${d.activeTenancy.unit_label}, ${d.activeTenancy.property_name}` : 'no active house';
  const lastPay = (d.payments as any[]).find((p) => p.status === 'VERIFIED');
  const bal = d.balanceMinor > 0 ? `owes ${K(d.balanceMinor)}`
    : d.balanceMinor < 0 ? `has ${K(-d.balanceMinor)} credit` : 'is fully paid up';
  return {
    answer: `${d.tenant.full_name} (${unit}) ${bal}.`
      + (lastPay ? ` Last verified payment: ${K(lastPay.amount_minor)} on ${lastPay.payment_date}${lastPay.receipt_no ? ` (receipt ${lastPay.receipt_no})` : ''}.` : ' No verified payments yet.'),
    tool: 'get_tenant_statement',
    data: { balanceMinor: d.balanceMinor, payments: (d.payments as any[]).slice(0, 5) },
  };
}

// -------------------------------------------------- offline command parser --
const HELP: AssistantReply = {
  answer: 'I answer from the records on this device — no internet needed. Try:\n'
    + '• "Who has not paid?" / "Nani hajalipa?"\n'
    + '• "How much did I collect in September?"\n'
    + '• "Which houses are vacant?"\n'
    + '• "What did I spend this month?"\n'
    + '• "Any payments waiting for verification?"\n'
    + '• "Open maintenance?"\n'
    + '• A tenant\u2019s name — e.g. "John Kamau balance"',
  tool: 'help',
  suggestions: ['Who has not paid?', 'How much did I collect this month?', 'Which houses are vacant?'],
};

/** Find a tenant whose name appears in the question (longest match wins). */
function findTenantInQuestion(ctx: Ctx, q: string): any | null {
  const lower = ` ${q.toLowerCase()} `;
  let best: any = null; let bestLen = 0;
  for (const t of listTenants(ctx) as any[]) {
    const full = t.full_name.toLowerCase();
    if (lower.includes(full) && full.length > bestLen) { best = t; bestLen = full.length; continue; }
    for (const part of full.split(/\s+/)) {
      if (part.length >= 3 && new RegExp(`\\b${part}\\b`).test(lower) && part.length > bestLen) {
        best = t; bestLen = part.length;
      }
    }
  }
  return best;
}

export function askAssistant(ctx: Ctx, question: string): AssistantReply {
  const q = (question ?? '').trim();
  if (!q) return HELP;
  const lower = q.toLowerCase();

  if (/^(help|msaada|\?+)$/.test(lower) || /what can you/.test(lower)) return HELP;

  // order matters: most specific first
  if (/arrear|owe|owing|debt|deni|hajalipa|hawajalipa|not paid|hasn'?t paid|haven'?t paid|defaulter|overdue|late/.test(lower)) {
    return toolArrears(ctx, q);
  }
  if (/vacan|empty|wazi|unoccupied|occupan/.test(lower)) return toolVacant(ctx);
  if (/pending|verif|waiting|approve|mpesa|m-pesa/.test(lower)) return toolPending(ctx);
  if (/maintenan|repair|fix|fundi|broken|leak/.test(lower)) return toolMaintenance(ctx);
  if (/expense|spend|spent|cost|gharama|matumizi/.test(lower)) return toolExpenses(ctx, q);
  if (/collect|received|mapato|income|revenue|how much (did|have|came)/.test(lower)) return toolCollection(ctx, q);
  if (/summary|dashboard|overview|status|hali|habari/.test(lower)) return toolDashboard(ctx);

  const tenant = findTenantInQuestion(ctx, q);
  if (tenant) return toolTenant(ctx, tenant);

  return {
    ...HELP,
    answer: `I did not understand that. ${HELP.answer}`,
    tool: 'unknown',
  };
}
