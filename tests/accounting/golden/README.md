# Golden scenarios

> 50–100 reference cases with hand-computed expected results. Implementations
> may change; the expected numbers may not.
> — [NON_NEGOTIABLES §3](../../../docs/NON_NEGOTIABLES.md)

Each scenario is **data**, not code. The expected figures live in JSON with
their provenance recorded, and the spec reads them.

That separation is the whole point. A number written inline beside the code
that produces it is not an independent check: it drifts with the
implementation, because whoever changes the implementation is looking straight
at it while they do. Holding the numbers as data makes changing one a
deliberate act with a diff and a reviewer.

## The rule

**If a change to the costing, posting or rounding code makes a golden scenario
fail, the code is wrong — not the file.**

Do not adjust an expected value to match new output. Do not add a tolerance.
Do not round differently to close a gap. A golden scenario that fails is
telling you something true about the books; NON_NEGOTIABLES §4 governs what
happens next.

Changing an expected number requires the Accounting Guardian, and the reason
belongs in the commit.

## Coverage

| Scenario | Covers | Status |
|---|---|---|
| [A](scenario-a.json) | Weighted average across opening, purchase and sale; COGS, revenue, gross profit, closing valuation | Costing arithmetic **executed**; the journal-entry half waits for the posting engine (Wave 2) |
| [P01](posting-p01-jv-simple.json) | Manual JV, two lines; trial balance | Specified — runner: M2 QA lane |
| [P02](posting-p02-jv-multi-line.json) | Manual JV, four lines, fractional amounts; account ledger | Specified — runner: M2 QA lane |
| [P03](posting-p03-jv-rejections.json) | Every JV rejection; no number consumed by a rejection | Specified — runner: M2 QA lane |
| [P04](posting-p04-service-invoice.json) | Service invoice 10,000.0000; per-line half-up boundary; MVP variant fences | Specified — **executed** |
| [P05](posting-p05-customer-receipt.json) | Partial receipt 6,000.0000; customer ledger 4,000.0000; allocation rejections | Specified — **executed** |
| [P06](posting-p06-reversal.json) | Receipt and invoice reversal; reversal-of-reversal and double reversal rejected; everything to zero | Specified — **executed** |
| [P07](posting-p07-closed-period.json) | Closed / locked period rejection; reversal of a closed-period entry into today's period; replay after close | Specified — runner: M2 QA lane |
| [P08](posting-p08-idempotent-retry.json) | Three identical requests → one entry; key reuse; source uniqueness | Specified — M2 (JV steps) **executed**; M3 (invoice steps 6-9) **executed** against the real `modules/receivables` |
| [P09](posting-p09-mvp-journey.json) | The MVP journey across two tenants; trial balance at each checkpoint | Specified — **executed**; M4 asserts the same figures through the API |
| [P10](posting-p10-service-line-rounding.json) | A true half-way tie at the service-line boundary: half-up only | Specified — **executed** |
| [P11](posting-p11-receipt-draft-lifecycle.json) | Receipt drafts: no GL, allocation or numbering effect; a draft in a since-closed period rejected, re-dated, posted; a stale proposal rejected at post; draft → cancel | Specified — **executed** |
| [P12](posting-p12-inactive-customer.json) | A customer with a balance cannot be deactivated (`CUSTOMER_HAS_BALANCE`); once settled it can be; an inactive customer cannot be invoiced but is still paid in full; a receipt reversal never checks customer status | Specified — **executed**. **Rewritten 2026-09-29, Accounting seat ruling 2 (review of M3-Q @ 43be499): the original version had a customer with a 10,000.0000 balance deactivate successfully, contradicting `modules/customers`' own merged rule** |
| [P13](posting-p13-coa-create-and-rename.json) | A user-created account: create, six create rejections, post, TB and ledger, rename alters no history, code/parent frozen after posting, protected accounts, pre-posting re-code and re-parent ([coa-standard.md](../../../docs/posting-rules/coa-standard.md) §8) | **PENDING** — specified 2026-09-29 (M2-C). Migration 018 and the kernel's account create/edit (`chartOfAccounts.create/update`) exist; what remains is the runner learning the `'account'` step verb — out of the M2-C lane's own scope, and untouched by M3-Q (P04-P12 only) |

**M3-Q status (2026-10-01, closing [TD-015](../../../docs/TECH_DEBT.md)).** P04-P06 and P09-P12
run wholly through `posting-scenarios-m3.spec.ts`; P08 runs its JV steps (1-5) through M2's own
`posting-scenarios.spec.ts` and its invoice steps (6-10) through the M3 file — all against the
REAL `modules/receivables` (`tests/accounting/receivables-real-port.ts`'s `ReceivablesPort`
adapter), not a fake. `tests/accounting/golden-posting-runner.ts` executes every verb and
expectation key P04-P12 use (`saveDraft`/`editDraft`/`cancelDraft`, `reverseDocument`, `customer`,
`invoiceOutstanding`, `customerLedger`, `invariant9`, `documentStatuses`,
`documentNumbersIssued`, a line's `party`, `invariant6.perCustomerResidual`); it was first proved
against a FAKE `ReceivablesPort` in `tests/accounting/golden-posting-runner-m3.spec.ts` before the
real module existed, which stays as a runner-logic test and is not itself evidence these
scenarios pass against the real system — that evidence is `posting-scenarios-m3.spec.ts`, which is
what the gate runs. `tests/accounting/golden-posting-registry.ts`'s own `PENDING` list is empty for
the M3 scenarios and carries exactly one entry, P13, above.

Fourteen of the promised 50–100. The rest arrive with the waves that make them
expressible — there is no value in writing a scenario for a posting engine
that does not exist, and considerable harm in stubbing one green.

## Posting scenarios (`posting-scenario/v1`)

P01–P10 were written by the Accounting seat in M2-000, and P11–P12 in
M3-000c (2026-09-28), together with the rules they pin in [`docs/posting-rules/`](../../../docs/posting-rules/). They
use an **extended format** — steps, rejections, checkpoints — described in
[`docs/posting-rules/README.md`](../../../docs/posting-rules/README.md) §6,
because Scenario A's costing shape cannot express a sequence of postings.

They are **specified, not executed**. `golden-scenarios.spec.ts` reads
`scenario-a.json` by name, so these files are inert until the M2 QA lane
writes the runner; M2-000 changed no test code. Every expected figure was
computed by hand, and before commit each file was replayed by an independent
decimal.js simulation that re-derived every entry, trial balance, ledger and
running balance and matched all of them. That check is evidence for the
review, not a substitute for the runner.

## Note on duplication

Scenario A's arithmetic is also asserted inside
`packages/validation/src/money.test.ts`, as a unit test of the money
primitives. That is deliberate: this file is the canonical record of what the
business expects, the other is a test of one package. If they ever disagree,
this file wins.
