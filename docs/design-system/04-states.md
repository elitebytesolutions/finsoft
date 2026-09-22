# States

Every data surface declares all of these. A page document lists the copy for the ones that are
page-specific; the rest inherit from here.

---

## 1. Loading

- **Skeletons, not spinners.** A table renders its header plus 6–10 shimmer rows; KPIs render their
  label and a shimmer value; a chart renders its frame.
- Skeletons keep the real layout so nothing jumps when data lands.
- A spinner is allowed only inside a button (busy state) and in an overlay that is already open.
- Above 400ms on a mutation, the primary button goes busy and the form locks.

## 2. Empty — no records exist yet

Icon well + heading + one sentence + one primary action.

> **No vouchers yet**
> Vouchers you create or post will appear here.
> `[+ New voucher]`

## 3. Empty — filters matched nothing

Different from 2. Never show a create action here.

> **No results for these filters**
> Try a wider date range or clear the status filter.
> `[Clear all filters]`

## 4. Error

> **We could not load the ledger**
> The server returned an error. Nothing was changed.
> `[Try again]`  ·  Reference: `REQ-8f21c4`

Rules: name what failed, state whether anything changed, offer one retry, always print the request
reference the user can quote to support. Never "Something went wrong". Never auto-retry a mutation.

## 5. Permission denied

Lock icon, the role named, no retry, one route out.

> **Access restricted**
> The Salesman role does not have permission to open Chart of Accounts.
> `[Return to dashboard]`

A module the role cannot open is **absent from navigation**; this state exists for deep links.
For an *action* the role cannot perform, the control is rendered disabled with the reason in its
tooltip — visible, so users can ask for the right permission.

## 6. Period locked

Sticky banner at the top of the content area, `warn` tone, `LockKeyhole` icon:

> **September 2026 is closed.** Postings dated in a closed period are rejected. Choose an open
> period or post a dated entry into the current period. `[Open period settings]`

While it shows: every post/submit control on the page is disabled with the same reason, date
pickers mark closed periods, and draft saving remains allowed. There is no override control in the
UI, for any role — [NON_NEGOTIABLES](../NON_NEGOTIABLES.md).

## 7. Posted / immutable

Not an error state — a display mode. Inputs are replaced by read-only surfaces, edit affordances
are absent, and the only mutating actions are `Reverse` and `Copy to new`.
The document header carries `Posted` and the `AuditStamp` carries who and when.

## 8. Unbalanced / invalid entry

Inline per field, plus a `FormErrorSummary` listing every problem with links to the fields.
On a `DrCrGrid`, the difference figure sits in the totals row in `--money-negative` and the post
button's tooltip reads "Debits and credits differ by Rs 1,250.00".

## 9. Stale data

When the underlying data changed while the page was open (another user posted, a period closed):

> This page was loaded at 10:24. New postings exist. `[Refresh]`

Never silently re-render a table the user is reading.

## 10. Offline / request failed mid-post

> **We did not get a confirmation.** Your voucher may or may not have been posted.
> `[Check status]` — the check re-queries by idempotency key and reports the true outcome.

The UI never assumes success and never re-submits automatically.

## 11. Not found

> **Record not found**
> This document does not exist, or it belongs to another company.
> `[Back to register]`

Tenant mismatch and genuine absence are **deliberately indistinguishable** — a cross-tenant probe
must not be able to tell them apart.

## 12. Saving / saved

Draft save is optimistic with a quiet `Saved HH:MM` marker. **Posting is never optimistic**: the UI
waits for the server's document number and shows it in the success toast.
