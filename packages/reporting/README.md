# @finsoft/reporting

Report definitions, query builders and exporters. Reports read; they never correct. A figure that looks wrong in a report is wrong in the ledger.

**May import:** `packages/database`, `packages/validation`, `packages/shared-types`.

Query bodies (which rows, what order) live in `packages/database/src/accounting/**`.
This package's job is decimal arithmetic and shape over those queries, using
`@finsoft/validation`'s `Money` — nothing here does native `number` arithmetic
on a monetary value.

Started early, in M2-A (accounting core foundation), ahead of Wave 8's original
schedule: the posting engine and its golden scenarios need a real ledger and
trial balance to assert against, not a mock. Enforced by dependency-cruiser in
CI (FND-002).

- `accountLedger` — running balance for one account, by date range, optional party.
- `trialBalance` — as of any date, summed from `journal_lines` directly, never a cached balance.
- `customerSubledgerBalance` / `vendorSubledgerBalance` — one party's balance against its control account (the GL half of FinancialInvariantSuite Invariant 9 — the subledger-document half arrives with M3).
