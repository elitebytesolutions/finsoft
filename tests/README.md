# tests/

Cross-cutting suites. Tests that belong to one package live beside it; these
are the ones that span packages or assert system-wide truth.

| | |
|---|---|
| `accounting/` | The **FinancialInvariantSuite** and `golden/` — 50–100 reference cases with hand-computed expected results. Implementations may change; the expected numbers may not. |
| `integration/` | Cross-module behaviour against a real PostgreSQL. |
| `e2e/` | Playwright journeys. |
| `security/` | Adversarial tenant isolation, IDOR, privilege escalation. Run on every PR. |
| `performance/` | The budgets in ARCHITECTURE.md §11. |
| `reconciliation/` | Subledger-to-GL and ledger-to-valuation agreement. |

A red test is information, not an obstacle. Never `it.skip` one, never add a
rounding tolerance, never widen an assertion to reach green.
