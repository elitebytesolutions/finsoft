/*
 * The FinancialInvariantSuite registry. NON_NEGOTIABLES §3.
 *
 * Ten invariants, quoted verbatim. Three of them (3, 9, 10) describe a stock
 * ledger and subledgers that do not exist yet (Wave 5; M3's customer and
 * invoice tables), so they cannot be executed yet.
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
    status: 'enforced',
    note:
      'M2-A. Three points: the kernel (JV_UNBALANCED; assertEntryWellFormed for every rule, never ' +
      'auto-corrected), the deferred balance trigger at COMMIT (migration 012), and this suite, which ' +
      'checks every entry of every tenant and proves the database refuses an unbalanced commit.',
  },
  {
    id: 2,
    statement: 'Trial balance debits = trial balance credits, for every tenant, every period',
    status: 'enforced',
    note:
      'M2-A. Checked for every tenant at every fiscal period end, from the journal itself (rule 11: ' +
      'balances are SUM(journal_lines), never a cache).',
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
    status: 'enforced',
    note:
      'M2-A. The suite attempts every mutation path as finsoft_app — UPDATE of each immutable column, ' +
      'the reverse status transition, UPDATE/DELETE of lines, appending a line — and asserts each is ' +
      'refused and the entry is byte-identical afterwards. POSTED -> REVERSED is the only update.',
  },
  {
    id: 5,
    statement: 'A closed fiscal period cannot receive a posting',
    status: 'enforced',
    note:
      'M2-A. Kernel: PERIOD_CLOSED / PERIOD_LOCKED for posts and reversals, no user = FORBIDDEN. ' +
      'Database: a direct INSERT into a CLOSED or LOCKED period is refused by the trigger for ' +
      'finsoft_app AND the BYPASSRLS migration role; a period/date mismatch is refused; posting-vs-close ' +
      'is serialised both ways (database/tests/accounting-triggers.spec.ts). This suite repeats the ' +
      'closed-period refusal for both roles, pinned to the trigger message rather than SQLSTATE 23514 ' +
      'alone, and scans every entry of every tenant for a date inside its own fiscal period.',
  },
  {
    id: 6,
    statement: "A reversal exactly neutralises the original's financial impact",
    status: 'enforced',
    note:
      'M2-A. For every reversal pair of every tenant the WHOLE (account, party) residual map is ' +
      'compared cell by cell with 0.0000; each pair has its original line count and its original is ' +
      'REVERSED by it. The golden runner compares the whole per-account map too. Both date branches ' +
      '(original period open / closed) are exercised. Subledger and stock legs arrive with M3/Wave 5.',
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
    status: 'enforced',
    note:
      'M2-A. Sequential and genuinely concurrent duplicates (the loser forced to race past step 2) ' +
      'produce one entry, one number, one posting audit record, and no gap in the series; key reuse ' +
      'with different content is IDEMPOTENCY_KEY_REUSED.',
  },
  {
    id: 9,
    statement: 'Subledger totals reconcile to their GL control accounts (AR, AP, Inventory)',
    status: 'enforced',
    note:
      'AR half: M3-Q, 2026-10-01 (M3-P @2a02731+ merged). docs/posting-rules/customer-receipt.md §8: ' +
      'GL(C,D) = SUB(C,D) exactly, for every customer of every tenant with subledger activity, plus ' +
      'the structural Σ GL(C,D) = AR_CONTROL balance — tests/accounting/ar-invariant-9.ts, checked live ' +
      'in financial-invariant-suite.spec.ts and tests/reconciliation/subledger-to-gl-ar.spec.ts, against ' +
      'real sales_invoices/customer_receipts rows, not fixtures. Inventory half: Wave 5 (ADR-0015, id ' +
      '10 below, same gap). AP half: Wave 6 (vendors) — docs/reconciliation/dormant.spec.ts re-arms the ' +
      "moment a posting rule reaches an AP control account; enforced is this invariant's AR coverage, " +
      'not yet its AP coverage, exactly as id 6 is enforced for its GL-only scope ahead of subledger ' +
      'and stock legs.',
  },
  {
    id: 10,
    statement: 'Inventory ledger valuation reconciles to the inventory GL account balance',
    status: 'pending',
    note:
      'Needs the inventory ledger and the inventory GL account. Wave 5. Ruled on by ADR-0015: ' +
      'valuation is the carried value, not quantity x average, so reconciliation is exact and no ' +
      'tolerance is involved. Golden Scenario A specifies the identity; it cannot yet observe it, because no journal exists to reconcile against until Wave 2.',
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
