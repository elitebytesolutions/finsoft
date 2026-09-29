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
| [P04](posting-p04-service-invoice.json) | Service invoice 10,000.0000; per-line half-up boundary; MVP variant fences | Specified — executable from M3 |
| [P05](posting-p05-customer-receipt.json) | Partial receipt 6,000.0000; customer ledger 4,000.0000; allocation rejections | Specified — executable from M3 |
| [P06](posting-p06-reversal.json) | Receipt and invoice reversal; reversal-of-reversal and double reversal rejected; everything to zero | Specified — executable from M3 |
| [P07](posting-p07-closed-period.json) | Closed / locked period rejection; reversal of a closed-period entry into today's period; replay after close | Specified — runner: M2 QA lane |
| [P08](posting-p08-idempotent-retry.json) | Three identical requests → one entry; key reuse; source uniqueness | Specified — M2 (JV steps), M3 (invoice steps) |
| [P09](posting-p09-mvp-journey.json) | The MVP journey across two tenants; trial balance at each checkpoint | Specified — executable from M3; M4 asserts the same figures through the API |
| [P10](posting-p10-service-line-rounding.json) | A true half-way tie at the service-line boundary: half-up only | Specified — executable from M3 |

Eleven of the promised 50–100. The rest arrive with the waves that make them
expressible — there is no value in writing a scenario for a posting engine
that does not exist, and considerable harm in stubbing one green.

## Posting scenarios (`posting-scenario/v1`)

P01–P10 were written by the Accounting seat in M2-000, together with the
rules they pin in [`docs/posting-rules/`](../../../docs/posting-rules/). They
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
