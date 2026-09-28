# Kitabu Digital — AI Assistant Architecture

## 1. Boundary

The AI is a convenience layer **on top of** deterministic application services. It is never the source of truth, never touches the database, never bypasses permissions.

```
User ("Who hasn't paid this month?")
  ↓
AI Assistant (cloud LLM via provider abstraction)
  ↓ intent → tool call (JSON, schema-validated)
Tool Registry  →  Permission check (same RBAC as the UI, as the *current user*)
  ↓
Application Service (the same RecordPayment/GetArrears used by the UI)
  ↓
Repositories → SQLite
  ↓
Structured result → AI formats the answer (figures come from the data, never generated)
```

## 2. Tools

**Read-only (Phase 7a):** `get_arrears`, `get_dashboard`, `search`, `get_tenant_statement`, `get_payment_history`, `get_vacant_units`, `get_open_maintenance`, `get_expense_summary`.

**Mutating (Phase 7b, confirmation required):** `create_tenant`, `record_payment`, `create_expense`, `create_maintenance_request`, `generate_receipt`.

Mutation flow: the AI *proposes* a fully-specified action → Kitabu renders a deterministic confirmation card built from the tool arguments ("Record KSh 12,000 from John Kamau, House A-12, M-Pesa ref SFR8K2L9QX?") → only an explicit user tap executes it through the normal service (validation, state machine, audit log). The AI never executes; it only proposes.

## 3. Guarantees

- Numbers in answers are copied from tool results; if a tool fails, the assistant says so — it never estimates financial figures.
- Tool calls run under the signed-in user's role; a caretaker's assistant cannot read org-wide financials.
- Every AI-triggered action is audit-logged with `via: assistant`.
- Provider abstraction (`AiProvider`: complete/toolCall) so the product is not tied to one LLM vendor; provider keys live server-side (cloud AI gateway), not on devices.

## 4. Offline behaviour

- Core app never depends on the AI. Offline ⇒ the assistant panel shows "AI needs internet — everything else works normally."
- A lightweight **offline command parser** (deterministic patterns, no LLM) handles simple phrases locally: "arrears", "vacant houses", "John statement" → routed to the same tools. No local LLM is shipped to budget devices.
