import type { APIRequestContext } from '@playwright/test'
import { apiCall, newIdempotencyKey, type ApiResult, type ApiSession } from './api-client.ts'

/*
 * The `afterAll` safety net for mvp-journey.deployed.spec.ts, factored out of that file so it
 * can be unit-tested directly (reversal-cleanup.spec.ts) — the risk here is high enough (real
 * money, on a shared demo tenant, reversed automatically with no human in the loop) that "it
 * typechecks and the one e2e run I could do locally didn't hit the bad path" is not enough
 * evidence on its own.
 *
 * ── The gap this exists to close, and the gap found in each fix so far ────────────────────────
 *
 * Round 1: `posted.invoiceId`/`posted.receiptId` were only recorded after the INV-/RCT- heading
 * rendered — a post that succeeded on the server and then failed to render was invisible to
 * cleanup. Fixed by flagging `invoicePossiblyPosted`/`receiptPossiblyPosted` BEFORE the click
 * that risks it, and resolving what actually happened afterwards by listing the customer's
 * documents (I1/R1) instead of trusting a captured id.
 *
 * Round 2: that resolution trusted the server's OWN `customerId` filter completely. I1/R1 are
 * not implemented yet (as of this writing — feature/M3-P-receivables is still uncommitted work).
 * If that filter is ever ignored or broken, "list this customer's invoices" would return every
 * invoice on the tenant, and reversing every `POSTED` item in that list would reverse every
 * invoice and receipt on `BHATTI1`/`BHATTI2` — a real, unrecoverable act (rule 2: posted records
 * are immutable; the only way back from an unwanted reversal is ANOTHER posting, not an undo) on
 * a tenant this suite does not own the other data on.
 *
 * The fix is defence in depth, not "trust the query harder":
 *
 *   1. Every candidate is matched client-side against the id `posted.customerId` recorded at
 *      customer-creation time (`reverseMatchingPosted`'s `item.customer.id !== customerId`
 *      check) — the ONE property no broken server-side filter can spoof, since the customer id
 *      this run cares about was decided by THIS run, not read back from the list response.
 *      A mismatch is reported, never reversed.
 *   2. A hard cap (`MAX_DOCS_THIS_RUN_COULD_HAVE_CREATED`, in `reverseLeftovers`): this run can
 *      create at most one invoice and one receipt, ever. A combined list longer than that is
 *      itself the signal that the filter cannot be trusted, and `reverseLeftovers` refuses to
 *      reverse ANYTHING — not just the excess — and throws, rather than reversing whatever
 *      happens to pass the per-item check on a list that should never have been this long.
 */

/** The one property every candidate is checked against before it is ever reversed. */
export interface ListedDoc {
  id: string
  number: string | null
  status: string
  customer: { id: string }
}

/**
 * What one tenant's run might have posted. `customerId`/`customerName` are known from the
 * moment step 2 returns 201 — long before either document exists — and are enough on their own
 * to find anything this run posted: each run's customer is created fresh with a name unique to
 * that run, so nothing genuinely posted under this `customerId` could belong to any other run.
 *
 * `invoicePossiblyPosted` / `receiptPossiblyPosted` are set immediately before the SECOND click
 * of each confirm dialog — the one that actually calls I7/R6 — and are never unset again. A flag
 * set before the click that risks it cannot miss a post that succeeded on the server and then
 * failed to render; the worst case is a redundant, harmless list call when nothing was actually
 * posted.
 */
export interface PostedDocs {
  session?: ApiSession
  customerId?: string
  customerName?: string
  invoicePossiblyPosted?: boolean
  receiptPossiblyPosted?: boolean
}

export const CLEANUP_REASON = 'E2E deployed check: automatic cleanup after an interrupted run'

export function acceptableReversalResult(result: ApiResult<{ error?: string }>): boolean {
  // 200: reversed just now, by this cleanup. 409 ALREADY_REVERSED: the in-test step (7) already
  // reversed it, by the UI, before the test itself failed for some unrelated reason —
  // reversal.md §3 row 2's own error code, not guessed at.
  return (
    result.status === 200 || (result.status === 409 && result.body?.error === 'ALREADY_REVERSED')
  )
}

/** I1/R1, filtered by `customerId` — the filter this whole file assumes could be lying. */
export async function listPossiblyPosted(
  request: APIRequestContext,
  session: ApiSession,
  kind: 'invoice' | 'receipt',
  customerId: string,
  who: string,
  problems: string[],
): Promise<ListedDoc[]> {
  const listPath = kind === 'invoice' ? '/api/invoices' : '/api/receipts'
  try {
    const list = await apiCall<{ items: ListedDoc[] }>(request, session, 'GET', listPath, {
      query: { customerId },
    })
    if (!list.ok) {
      problems.push(`listing ${kind}s${who}: ${list.status} ${JSON.stringify(list.body)}`)
      return []
    }
    return list.body.items
  } catch (error) {
    problems.push(`listing ${kind}s${who}: ${String(error)}`)
    return []
  }
}

/**
 * Reverses whichever of `items` are `POSTED` **and** actually belong to `customerId` — checked
 * against `item.customer.id`, never assumed from how the item was listed. A `DRAFT` is left
 * alone (zero accounting effect: service-sale.md §2 / customer-receipt.md §1.1); `REVERSED` and
 * `CANCELLED` need nothing. A `POSTED` item under a DIFFERENT customer is reported and left
 * exactly as it was — this is the one rule this whole module exists to enforce, so it is
 * unconditional: there is no path through this function that reverses a mismatched item.
 */
export async function reverseMatchingPosted(
  request: APIRequestContext,
  session: ApiSession,
  kind: 'invoice' | 'receipt',
  customerId: string,
  who: string,
  items: readonly ListedDoc[],
  problems: string[],
): Promise<void> {
  const listPath = kind === 'invoice' ? '/api/invoices' : '/api/receipts'

  for (const item of items) {
    if (item.status !== 'POSTED') continue

    if (item.customer.id !== customerId) {
      problems.push(
        `${kind} ${item.number ?? item.id}${who}: listed for customer ${customerId} but ` +
          `belongs to ${item.customer.id} — NOT reversed (the customerId filter may be broken)`,
      )
      continue
    }

    const label = `${kind} ${item.number ?? item.id}${who}`
    try {
      const result = await apiCall<{ error?: string }>(
        request,
        session,
        'POST',
        `${listPath}/${item.id}/reverse`,
        { data: { reason: CLEANUP_REASON }, idempotencyKey: newIdempotencyKey() },
      )
      if (!acceptableReversalResult(result)) {
        problems.push(`${label}: ${result.status} ${JSON.stringify(result.body)}`)
      }
    } catch (error) {
      problems.push(`${label}: ${String(error)}`)
    }
  }
}

/** This run can create at most one invoice and one receipt, ever — see the file header, point 2. */
export const MAX_DOCS_THIS_RUN_COULD_HAVE_CREATED = 2

/**
 * The `afterAll` safety net itself. Best-effort in the sense that a listing failure for one kind
 * does not stop the other kind from being tried — but NOT best-effort in the sense of swallowing
 * a problem: anything still unreversed, mismatched, or over the cap is thrown as a named,
 * actionable error, reported as its own failure alongside (never in place of) the test's own.
 * PO-Q1 order preserved: every receipt for this customer is reversed before any invoice is — an
 * invoice with a still-LIVE allocation cannot be reversed at all (service-sale.md §8).
 */
export async function reverseLeftovers(
  request: APIRequestContext,
  posted: PostedDocs,
): Promise<void> {
  if (!posted.session || !posted.customerId) return // never logged in, or never got a customer — nothing could have posted

  const session = posted.session
  const customerId = posted.customerId
  const who = posted.customerName
    ? ` (customer ${posted.customerName})`
    : ` (customer ${customerId})`
  const problems: string[] = []

  const receiptItems = posted.receiptPossiblyPosted
    ? await listPossiblyPosted(request, session, 'receipt', customerId, who, problems)
    : []
  const invoiceItems = posted.invoicePossiblyPosted
    ? await listPossiblyPosted(request, session, 'invoice', customerId, who, problems)
    : []

  const totalListed = receiptItems.length + invoiceItems.length
  if (totalListed > MAX_DOCS_THIS_RUN_COULD_HAVE_CREATED) {
    throw new Error(
      `Refusing to reverse anything${who}: listing returned ${totalListed} document(s) total ` +
        `(${receiptItems.length} receipt(s), ${invoiceItems.length} invoice(s)) — more than the ` +
        `${MAX_DOCS_THIS_RUN_COULD_HAVE_CREATED} this run could ever have created. The ` +
        `customerId filter (I1/R1) may be broken or ignored; reversing on an unfiltered list ` +
        `risks touching another customer's real, posted documents. Investigate by hand.`,
    )
  }

  await reverseMatchingPosted(request, session, 'receipt', customerId, who, receiptItems, problems)
  await reverseMatchingPosted(request, session, 'invoice', customerId, who, invoiceItems, problems)

  if (problems.length > 0) {
    throw new Error(
      `Deployed MVP journey left document(s) UNREVERSED or unresolved on a shared demo tenant ` +
        `after cleanup — fix by hand: ${problems.join('; ')}`,
    )
  }
}
