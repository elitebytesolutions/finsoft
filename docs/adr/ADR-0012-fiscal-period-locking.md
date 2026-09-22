# ADR-0012: Fiscal period locking with no system bypass

**Status:** Accepted
**Date:** 2026-09-22
**Deciders:** Product Owner, Architecture Guardian, Accounting Guardian
**Authority:** LEVEL 1 — reversing this requires a superseding ADR

## Context

A month-end close is an assertion: *these are the figures for this period, and they will not change.* The owner reads them, the accountant reconciles against them, a sales tax return is filed with the FBR on them, and a bank may lend against them.

The legacy system had no period control ([PRD.md §3](../PRD.md)). A posting could land in any month, including one already reported. The result was a closed month whose trial balance was different every time it was printed, and an accountant who reconstructed figures by hand rather than trusting the system.

Rule 5 of [NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md) is unambiguous: a closed period can never receive a posting, enforcement is at the posting engine **and** at the database, and *a background job, a data import, and an admin script are all subject to this rule — there is no "system" bypass.*

## Decision

### Lifecycle

```
OPEN ──────close─────▶ CLOSED ──────lock──────▶ LOCKED
  ▲                       │                        │
  └───────reopen──────────┘                        ✗  never
        period.reopen                                 (permanent)
        high-privilege, audited, step-up MFA
```

| Status | Postings | Transition out |
|--------|----------|----------------|
| `OPEN` | Accepted | → `CLOSED` by a holder of `period.close`, after the close checklist |
| `CLOSED` | **Rejected** | → `OPEN` by a holder of `period.reopen`; → `LOCKED` by a holder of `period.close` |
| `LOCKED` | **Rejected, permanently** | None. There is no transition out of `LOCKED`. |

- Every tenant has its own fiscal calendar; periods are per tenant, non-overlapping, contiguous, and cover the full fiscal year with no gaps.
- Every posting resolves to **exactly one** `fiscal_period` from its `occurredAt` business date (rule 13). A date matching no period is rejected — there is no fallback to the nearest period and no implicit period creation.
- `CLOSED` is the normal end state of a month. `LOCKED` is applied after statutory filing, when the figures have gone to the FBR and are no longer ours to change.
- Reopening a `CLOSED` period requires the `period.reopen` permission, which is a privileged role requiring MFA and step-up re-authentication (ADR-0009). It records a mandatory reason, writes an audit record, raises an operational alert, and is reported to the Product Owner. It exists for a close-process error found quickly — not as a route around the reversal date policy (ADR-0006).
- **`LOCKED` is permanent.** Not by an administrator, not by a superuser, not by a break-glass session, not by a migration. Reversing a locked period would mean changing a filed return, which is a matter for an amended filing, not for a database state change.

### Two enforcement points, both required

**1 — The posting engine.** Every call to `postingEngine.post(...)` resolves and validates the period before building any lines (step 3 of the pipeline in [ADR-0005](ADR-0005-central-double-entry-posting-engine.md)):

```
resolve fiscal_period from (tenantId, occurredAt)
  ├─ no period matches            → reject: no fiscal period for this date
  ├─ period.status = 'CLOSED'     → reject: period closed, name it, suggest
  │                                  posting into the current open period
  ├─ period.status = 'LOCKED'     → reject: period locked, permanently
  └─ period.status = 'OPEN'       → continue
```

This layer exists to fail early with a usable domain error that names the period and tells the user what to do instead.

**2 — The database.** A trigger on the journal entry and stock movement tables re-resolves the period from `occurred_at` and rejects any insert whose period is not `OPEN`:

```
BEFORE INSERT ON journal_entries / journal_lines / stock_movements:
  SELECT status INTO s FROM fiscal_periods
   WHERE tenant_id = NEW.tenant_id
     AND NEW.occurred_at::date BETWEEN start_date AND end_date;

  IF NOT FOUND       THEN RAISE EXCEPTION 'no fiscal period for %', NEW.occurred_at;
  IF s <> 'OPEN'     THEN RAISE EXCEPTION 'fiscal period is % (ADR-0012)', s;
```

The database layer is not a duplicate of the application check. It is the layer that holds for writers the application does not know about — a migration script, a psql session, a hotfix, an import written under deadline pressure, a future extracted service. It is the difference between a rule and a guarantee.

Closing a period also takes the period row `FOR UPDATE` and verifies no posting transaction is in flight for it, so a posting cannot slip in between the check and the close. A period transition is itself an audited event (`PERIOD_CLOSED` is in the financial event set) and writes its own record.

### There is no "system" bypass

Stated explicitly, because this is the exemption that gets requested in every accounting system and it is refused here:

```
Background job          subject to period control
Outbox dispatch         subject to period control
Data import             subject to period control
Legacy migration load   subject to period control
Admin script            subject to period control
Database migration      subject to period control
Break-glass session     subject to period control
An AI agent             subject to period control  (and may not post at all — rule 22)
```

There is no `SYSTEM` actor, no `bypassPeriodCheck` flag, no `--force` argument, no environment variable, no service account, and no code path that reaches the journal without the period check. An agent asked to "just load these entries into last quarter" has been asked to do something the system does not do; the correct response is to stop and flag it ([NON_NEGOTIABLES §4](../NON_NEGOTIABLES.md)).

The consequences are accepted, not worked around:

- **Legacy migration** loads through the normal posting engine as opening balances, into an open period, never as direct inserts into the journal ([PRD.md §8](../PRD.md)). Historical periods are created and closed in order, with the load happening while each is open.
- **A late invoice** for a closed month posts into the current open period with its business date in that period. If the prior-period effect matters, it is disclosed, not back-dated.
- **A correction to a closed period** is a reversal in the current open period with disclosure (ADR-0006). This is the policy the reopen permission must not be used to circumvent.
- **A retried outbox dispatch** never posts, so the question does not arise — the outbox carries side effects, not postings (ADR-0010).

## Consequences

### Positive

- A closed period's trial balance is the same figure every time it is printed. That is the entire point, and it is what makes [PRD.md §10](../PRD.md) criterion 1 — closing a month without reconstructing numbers by hand — achievable.
- Filed FBR returns remain reconcilable to the ledger indefinitely, because `LOCKED` means the underlying data cannot move.
- The close process becomes meaningful: a checklist with a state transition behind it, rather than a convention.
- Database-level enforcement removes the "someone ran a script" incident category entirely.
- Reopening is rare, visible and attributable, so it can be reviewed rather than discovered.

### Negative / accepted costs

- Genuine late documents must be posted with a current-period date and disclosed, which is an accounting discipline the business has to adopt and the UI has to explain clearly.
- Migration and data-loading tooling is harder to write: it has to sequence period creation, loading and closing rather than inserting rows freely. Accepted — that tooling is exercised once, and the guarantee is permanent.
- The database trigger re-resolves the period on every financial insert. The lookup is indexed on `(tenant_id, start_date, end_date)` and cached in the planner; measured, and within the posting budget.
- `LOCKED` being irreversible means a mistaken lock is unrecoverable through the application. Accepted deliberately: locking requires `period.close` plus a confirmation step, and the alternative — a recoverable lock — is not a lock.
- `period.reopen` is a genuinely dangerous permission that exists and will occasionally be used. Contained by MFA, step-up, mandatory reason, audit and alert, but it is real residual risk.
- A closed period blocks operational postings too — a stock adjustment found during a count in a closed month goes into the current period. Correct, and occasionally counter-intuitive to a storekeeper.

## Alternatives considered

**Soft period control — warn on a closed-period posting but allow it with confirmation.** Rejected. A warning that can be clicked through is not a control, and it will be clicked through at month end when someone is in a hurry. Rule 5 says "never", not "with a warning".

**Application-layer enforcement only.** Rejected by rule 5, which requires database-level enforcement. It also leaves every non-application writer — import, script, migration, future service — outside the rule, which is precisely where the incidents come from.

**A privileged bypass for system processes (imports, migrations, jobs).** Rejected, explicitly and by name in rule 5. A bypass that exists will be used, and the processes requesting it — bulk imports, migration loads — are the ones most capable of writing many wrong rows into a reported period before anyone notices. Migration loads through the normal path instead.

**Allowing back-dated reversals into closed periods with sufficient permission.** Rejected. See ADR-0006's reversal date policy: a closed period's figures have been reported, and permission does not un-report them.

**Making `LOCKED` reversible by a superuser "for emergencies".** Rejected. `LOCKED` is applied after statutory filing; an emergency that requires changing filed figures is an amended return, handled with the regulator, not a database state change. A reversible lock provides none of the assurance that justifies having the state at all.

**Auto-closing periods on a schedule.** Rejected for v1. Closing is an accountant's assertion following a checklist, not a calendar event. A reminder is appropriate; an automatic transition is not.

## Compliance

- Database trigger on `journal_entries`, `journal_lines` and `stock_movements` rejecting any insert whose resolved period is not `OPEN`, and rejecting any insert whose date resolves to no period.
- Schema: `fiscal_periods` has a per-tenant exclusion constraint preventing overlapping date ranges, and a test asserting each fiscal year is contiguous with no gaps.
- Schema: a trigger permitting only the transitions `OPEN → CLOSED`, `CLOSED → OPEN`, `CLOSED → LOCKED`. Any transition out of `LOCKED` raises, including by the migration role.
- FinancialInvariantSuite Invariant 5 — a closed fiscal period cannot receive a posting. Exercised against the real database so the trigger is the thing under test.
- Test matrix asserting rejection for **every** actor: an authenticated user, an admin, a background job, the outbox dispatcher, an import routine, a direct SQL insert as the application role, and a direct SQL insert as the migration role.
- Code search check in CI: no identifier matching `bypassPeriod`, `skipPeriodCheck`, `forcePost`, `systemActor` or equivalent exists in the codebase. A new one fails the build.
- Permission test: `period.close` and `period.reopen` are privileged permissions requiring MFA enrolment and step-up re-authentication (ADR-0009); `period.reopen` additionally requires a non-empty reason.
- Every close, reopen and lock writes an audit record in the same transaction as the transition (rule 9), and emits `PERIOD_CLOSED` as a logged business event ([ARCHITECTURE.md §10](../ARCHITECTURE.md)). A reopen raises an operational alert.
- Migration test: the legacy import is asserted to post through `postingEngine.post(...)` and to fail if it attempts a direct journal insert ([PRD.md §8](../PRD.md)).

## Related

- [ADR-0005](ADR-0005-central-double-entry-posting-engine.md) — the period check as step 3 of the posting pipeline
- [ADR-0006](ADR-0006-immutable-posted-transactions.md) — the reversal date policy this rule shapes
- [ADR-0009](ADR-0009-jwt-access-and-rotating-refresh-tokens.md) — MFA and step-up for `period.reopen`
- [ADR-0010](ADR-0010-transactional-outbox.md) — why dispatch retries never raise a period question
- [ADR-0008](ADR-0008-inventory-movement-ledger-and-fefo.md) — stock movements are period-checked like journal entries
- [../NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md) — rules 5, 9, 13, 18, 22; §4 what to do when you hit a violation
- [../ARCHITECTURE.md](../ARCHITECTURE.md) — §3 period validation, §8 permissions, §10 observability
- [../PRD.md](../PRD.md) — §4.2 fiscal periods, §8 migration, §10 success criteria
