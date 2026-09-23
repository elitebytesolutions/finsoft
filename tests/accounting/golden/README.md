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

One of the promised 50–100. The rest arrive with the waves that make them
expressible — there is no value in writing a scenario for a posting engine
that does not exist, and considerable harm in stubbing one green.

## Note on duplication

Scenario A's arithmetic is also asserted inside
`packages/validation/src/money.test.ts`, as a unit test of the money
primitives. That is deliberate: this file is the canonical record of what the
business expects, the other is a test of one package. If they ever disagree,
this file wins.
