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

**Never paste a password into a command, and never paste one through `!` in a Claude session or
into any agent chat.** A password pasted straight into a command string lands in your shell
history on disk, and pasting it to an agent puts it in that session's transcript — neither is
somewhere a credential for a shared tenant belongs. Type each password at your own terminal's
prompt instead, where it is never echoed and never written anywhere:

**bash / Git Bash:**

```bash
read -rs -p "BHATTI1 Accountant password: " E2E_BHATTI1_ACCOUNTANT_PASSWORD; echo
read -rs -p "BHATTI2 Accountant password: " E2E_BHATTI2_ACCOUNTANT_PASSWORD; echo
export E2E_BHATTI1_ACCOUNTANT_PASSWORD E2E_BHATTI2_ACCOUNTANT_PASSWORD
export E2E_BASE_URL=https://31-220-74-159.sslip.io

npx playwright test --config tests/e2e/playwright.deployed.config.ts \
  tests/e2e/mvp-journey.deployed.spec.ts --reporter=list
```

**PowerShell:**

```powershell
$b1 = Read-Host -AsSecureString "BHATTI1 Accountant password"
$b2 = Read-Host -AsSecureString "BHATTI2 Accountant password"
$env:E2E_BHATTI1_ACCOUNTANT_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($b1))
$env:E2E_BHATTI2_ACCOUNTANT_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($b2))
$env:E2E_BASE_URL = 'https://31-220-74-159.sslip.io'

npx playwright test --config tests/e2e/playwright.deployed.config.ts `
  tests/e2e/mvp-journey.deployed.spec.ts --reporter=list
```

`--reporter=list` is explicit above even though `playwright.deployed.config.ts` already pins
`reporter: [['list']]` for every `*.deployed.spec.ts` file — filling the password field renders
its literal value into Playwright's own step description (`Fill "<password>"`), which only an
HTML or JSON reporter would ever persist anywhere. Passing `--reporter=list` here means a stray
`--reporter=html` cannot be added later without someone noticing it contradicts this documented
command. `trace`, `screenshot` and `video` are already forced `off` inside the spec file itself,
so there is no trace or recording to check either way.

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

**This suite never retries** (`test.describe.configure({ retries: 0 })`, overriding
`playwright.deployed.config.ts`'s file-wide `retries: 1`) — a retry after money has already
posted would run the whole journey again and leave a *second*, unreversed set on a shared demo
tenant. If a step fails after the invoice or receipt posted but before step 7 reverses it, each
tenant's own cleanup hook still runs: it reverses, by direct API call (not the UI, since a broken
screen is exactly the failure this needs to survive), whatever that run posted and had not yet
reversed, in the same order (receipt, then invoice — PO-Q1) as the normal path. If it cannot
finish — say the API itself is down — it throws a named, actionable error listing exactly which
document(s) are still open, reported as its own failure alongside the test's. Either way, check
the run's output before assuming `BHATTI1`/`BHATTI2` are clean, and reverse anything it names by
hand if it says it could not.

### What it never does

Reads a credentials file itself, prints a password (to the console, a log, a trace, a screenshot
or a video — `trace`/`screenshot`/`video` are all forced `off` for this file specifically, and
`--reporter=list` above keeps a step's rendered `Fill "<password>"` description out of any
persisted report), or hardcodes a secret. The access token Playwright itself might echo into an
assertion failure's console output is a short-lived session credential the server can revoke, not
the account password.

## Proposal: wiring this into `tools/ship/staging.mjs`

Not implemented here — `tools/ship/staging.mjs` is DevOps-guardian territory and out of this
lane's `ALLOWED` paths. For whoever picks it up:

- Add an **optional** post-smoke step, after `infrastructure/staging/smoke.sh` passes, that runs
  exactly the command above — `playwright test --config tests/e2e/playwright.deployed.config.ts
  tests/e2e/mvp-journey.deployed.spec.ts --reporter=list` — with `E2E_BASE_URL` set to the same
  staging origin the smoke test just checked. The retry-off and net-zero cleanup behaviour live in
  the spec file itself (`test.describe.configure({ retries: 0 })`, each tenant's `afterAll`), not
  in the ship tool, so wiring this in needs no extra safety logic on that side — only passing the
  two password env vars through from wherever `ship:staging`'s caller keeps them, never printing
  or logging them, and surfacing the step's pass/fail (including a cleanup-hook failure, which is
  its own actionable signal that a demo tenant needs a human to look at it).
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
