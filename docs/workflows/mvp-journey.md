# The MVP journey test

**Status:** Operational for the local suite; the deployed suite is written and gated, waiting on
feature/M3-P-receivables and feature/M4-W-journey-screens. M4-E, IMPLEMENTATION.md §13 / plan
Part C "M4" — this is M4's acceptance gate.

The journey, for a tenant: log in, create a customer, post a service invoice for 10,000, receive
6,000 against it, watch the customer ledger and trial balance follow the money, reverse the
receipt then the invoice (PO-Q1), watch both come back to zero, and confirm the audit trail
recorded every step while another tenant saw none of it.

---

## The two files

| File | Runs against | Runs when |
|---|---|---|
| `tests/e2e/mvp-journey.spec.ts` | a local, disposable stack (`playwright.config.ts`) | every `npm run test:e2e` — no flags needed |
| `tests/e2e/mvp-journey.deployed.spec.ts` | a real deployment (`playwright.deployed.config.ts`) | only with explicit opt-in env vars (below) — never in the PR gate |

Both files run for **two tenants**, proving tenant isolation adversarially in each direction, not
only in one.

## The local suite

```
npm run test:e2e
```

Runs steps 1 (log in), 2 (create a customer), 6 (trial balance), 9 (audit trail) and 10 (tenant
isolation) for real, against a real API and a real, freshly-migrated database — no mocks. Steps
2 and the always-on half of 9 call the API directly (`tests/e2e/helpers/api-client.ts`) rather
than driving a screen, because `/customers` and `/admin-audit` are still `ui-prototype` mocks on
`develop` as of this writing; steps 1 and 6 drive the real `/login` and `/trial-balance` screens,
already merged from M1-A and M2-S.

Steps 3-5 and 7-8 — post the invoice, receive the receipt, check the ledger and TB, reverse both,
check them again — are written in full against `docs/design/M3/ui-plan.md` and the posting rules,
but need two things not yet on `develop`:

- **feature/M3-P-receivables** — the invoice/receipt API
- **feature/M4-W-journey-screens** — the sales-voucher and payments-centre screens

They are gated behind one switch, off by default:

```
E2E_RECEIVABLES_JOURNEY=1 npm run test:e2e -- tests/e2e/mvp-journey.spec.ts
```

or flip the `RECEIVABLES_JOURNEY_READY` constant at the top of the file to `true` once both
branches are on `develop`. With the switch off, the test still runs (steps 1/2/6/9/10, always
real) and records a `gated` annotation on why the rest did not.

## The deployed suite — how the Product Owner runs it

This posts real documents on the shared staging demo tenants, `BHATTI1` and `BHATTI2`
(`tools/seed/demo-tenants.mjs`), so it is opt-in only and never runs unattended in CI.

### What you need

1. The staging URL — the same one `ship:staging`'s smoke test uses:
   `https://31-220-74-159.sslip.io`.
2. The Accountant passwords for `BHATTI1` and `BHATTI2`. These are **not** in this repository —
   `tools/seed/demo-tenants.mjs`'s own rule is that generated demo passwords live in a `0600`
   file outside the repo that only you, the Product Owner, read. If you do not have that file,
   ask whoever last ran the demo-tenant seed script for it; nobody else opens it, including any
   agent running this test on your behalf.

### Run it

```
E2E_BASE_URL=https://31-220-74-159.sslip.io \
E2E_BHATTI1_ACCOUNTANT_PASSWORD='<paste from your credentials file>' \
E2E_BHATTI2_ACCOUNTANT_PASSWORD='<paste from your credentials file>' \
npx playwright test --config tests/e2e/playwright.deployed.config.ts tests/e2e/mvp-journey.deployed.spec.ts
```

Any one of the three variables missing and the file registers a single, always-passing
"opted out" placeholder test instead of the real journey — the run tells you what to set, rather
than silently skipping (the codebase's own ESLint rule forbids `test.skip`; this file never
uses it, see its own header comment).

### What it does, and what it leaves behind

For each tenant: creates one customer with a name unique to this run (`MVP Journey Check
<date> <random>`), posts a 10,000 service invoice, receives 6,000 against it, then **reverses the
receipt and the invoice before finishing** — the test asserts the customer's ledger closes at
exactly `0.0000` and the trial balance is `Balanced` afterwards. Nothing is deleted (rule 4): the
customer, the reversed invoice and the reversed receipt stay visible forever, exactly as a real
correction would. No fiscal period is ever closed or reopened by this file.

If a step fails **after** money has posted, the test does not attempt automatic cleanup — see the
comment above the reversal step in the file for why: guessing at a reversal from a partially
broken state risks posting something else wrong on a shared demo tenant. A failure past step 2
means a human (you) checks `BHATTI1`/`BHATTI2`'s open items and reverses by hand, with full
context, the same as any other posting correction.

### What it never does

Reads a credentials file itself, prints a password (to a log, a trace, a screenshot or a video —
`trace`/`screenshot`/`video` are all forced `off` for this file specifically), or hardcodes a
secret. The access token Playwright itself might echo into an assertion failure's console output
is a short-lived session credential the server can revoke, not the account password.

## Proposal: wiring this into `tools/ship/staging.mjs`

Not implemented here — `tools/ship/staging.mjs` is DevOps-guardian territory and out of this
lane's `ALLOWED` paths. For whoever picks it up:

- Add an **optional** post-smoke step, after `infrastructure/staging/smoke.sh` passes, that runs
  exactly the command above — `playwright test --config tests/e2e/playwright.deployed.config.ts
  tests/e2e/mvp-journey.deployed.spec.ts` — with `E2E_BASE_URL` set to the same staging origin the
  smoke test just checked.
- Keep it **optional and separate from the pass/fail gate that blocks a deploy**: this step posts
  and reverses real documents on a shared tenant, which is a materially different risk than a
  read-only smoke check, and a transient UI flake here should not trigger `ship:staging`'s
  automatic rollback of an otherwise-healthy deploy. Model it as a non-blocking "acceptance check"
  the tool reports on, not a gate step.
  Gate it behind its own flag, e.g. `--journey-check`, off by default — the two password env vars
  are exactly the kind of input `ship:staging` does not currently take, and requiring them
  unconditionally would break every ordinary ship.
  Record its pass/fail in the evidence file (`tools/ship/staging.mjs`'s existing evidence record)
  the same way every other gate step already is, so a run that included it is auditable later.
- Until that flag exists, the Product Owner runs the command above by hand, after a deploy,
  exactly as this document says.
