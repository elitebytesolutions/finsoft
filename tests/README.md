# tests/

Cross-cutting suites. Tests that belong to one package live beside it; these
are the ones that span packages or assert system-wide truth.

| | |
|---|---|
| `accounting/` | The **FinancialInvariantSuite** and `golden/` — 50–100 reference cases with hand-computed expected results. Implementations may change; the expected numbers may not. |
| `integration/` | Cross-module behaviour against a real PostgreSQL. API-to-database through the restricted role, migrations, and the transactional side-effect contract. Needs SWC, so it carries its own vitest config. |
| `e2e/` | Playwright journeys. A real Chromium against the real API, started from `dist`. |
| `security/` | Adversarial tenant isolation, IDOR, privilege escalation — serial **and concurrent**. Run on every PR. |
| `performance/` | Foundation round-trip latency today. **Not** the ARCHITECTURE §11 budgets, which are deferred — see `performance/README.md`. |
| `reconciliation/` | The reconcilers and their break detection, proved against fixtures. There is no live data to reconcile until a posting exists, so `dormant.spec.ts` is a tripwire that fails the moment there is. See `reconciliation/README.md`. |

Running them:

```
npm run test:gate          # everything below, in order
npm run test:schema        # database/tests — RLS, roles, schema
npm run test:security      # tenant isolation, serial and concurrent
npm run test:accounting    # FinancialInvariantSuite + golden scenarios
npm run test:reconciliation # subledger-to-GL and valuation-to-ledger break detection
npm run test:integration   # API↔database, migrations, worker
npm run test:performance   # foundation latency
npm run test:e2e           # Playwright; starts the API itself
```

`test:e2e` is not in `test:gate`: it builds the API and drives a browser, so it
is its own CI job rather than a step that doubles the gate's runtime.

A red test is information, not an obstacle. Never `it.skip` one, never add a
rounding tolerance, never widen an assertion to reach green.
