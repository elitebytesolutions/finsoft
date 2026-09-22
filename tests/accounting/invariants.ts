/*
 * The FinancialInvariantSuite registry. NON_NEGOTIABLES §3.
 *
 * Ten invariants, quoted verbatim. Seven of them describe a posting engine,
 * a fiscal calendar or a stock ledger that Wave 0 has not built, so they
 * cannot be executed yet.
 *
 * They are NOT silently omitted, and they are NOT stubbed green. Each is
 * registered with its real status and the thing that blocks it, and
 * `financial-invariant-suite.spec.ts` holds a ratchet over that list: the
 * pending set may shrink and may never grow. An invariant cannot quietly
 * disappear, and a green suite cannot be mistaken for a complete one.
 */

export type InvariantStatus = 'enforced' | 'pending'

export interface Invariant {
  readonly id: number
  /** Verbatim from the table in NON_NEGOTIABLES §3. */
  readonly statement: string
  readonly status: InvariantStatus
  /** How it is enforced, or what has to exist before it can be. */
  readonly note: string
}

export const INVARIANTS: readonly Invariant[] = [
  {
    id: 1,
    statement: '`Σ debit = Σ credit` for every posted journal entry',
    status: 'pending',
    note: 'Needs journal_entries and journal_lines. Wave 2, ADR-0005.',
  },
  {
    id: 2,
    statement: 'Trial balance debits = trial balance credits, for every tenant, every period',
    status: 'pending',
    note: 'Needs the journal and a fiscal calendar. Wave 2.',
  },
  {
    id: 3,
    statement: '`stock balance = Σ stock in − Σ stock out` for every product/location',
    status: 'pending',
    note: 'Needs stock_movements. Wave 5, ADR-0008.',
  },
  {
    id: 4,
    statement: 'A posted transaction cannot be modified',
    status: 'pending',
    note: 'Needs a posted record to try to modify. Wave 2, ADR-0006.',
  },
  {
    id: 5,
    statement: 'A closed fiscal period cannot receive a posting',
    status: 'pending',
    note: 'Needs fiscal_periods and the posting engine. Wave 2, ADR-0012.',
  },
  {
    id: 6,
    statement: "A reversal exactly neutralises the original's financial impact",
    status: 'pending',
    note: 'Needs the reversal engine. Wave 2, ADR-0006.',
  },
  {
    id: 7,
    statement:
      'Cross-tenant references are impossible (no journal line points at another tenant’s account)',
    status: 'enforced',
    note:
      'Enforced structurally, ahead of the journal existing: every foreign key between two ' +
      'tenant-owned tables must carry tenant_id, so the reference cannot cross a tenant even ' +
      'with RLS bypassed. ADR-0003:29 generalises the journal-line wording to every table.',
  },
  {
    id: 8,
    statement: 'A duplicated API call cannot double-post',
    status: 'pending',
    note: 'Needs the idempotency key path through the posting engine. Wave 2, ADR-0005.',
  },
  {
    id: 9,
    statement: 'Subledger totals reconcile to their GL control accounts (AR, AP, Inventory)',
    status: 'pending',
    note: 'Needs subledgers and control accounts. Wave 4.',
  },
  {
    id: 10,
    statement: 'Inventory ledger valuation reconciles to the inventory GL account balance',
    status: 'pending',
    note:
      'Needs the inventory ledger and the inventory GL account. Wave 5. Ruled on by ADR-0015: ' +
      'valuation is the carried value, not quantity x average, so reconciliation is exact and no ' +
      'tolerance is involved. Golden Scenario A asserts the identity today.',
  },
]

export const pendingIds = (): number[] =>
  INVARIANTS.filter((i) => i.status === 'pending')
    .map((i) => i.id)
    .sort((a, b) => a - b)

export const enforcedIds = (): number[] =>
  INVARIANTS.filter((i) => i.status === 'enforced')
    .map((i) => i.id)
    .sort((a, b) => a - b)
