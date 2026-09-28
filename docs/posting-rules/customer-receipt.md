# CUSTOMER_PAYMENT_RECEIVED@1 — customer receipt

| | |
|---|---|
| **Rule** | `CUSTOMER_PAYMENT_RECEIVED@1` |
| **Status** | APPROVED — Accounting seat, 2026-09-27 (M2-000) |
| **Implemented in** | M3 — customer receipt module raises the event; kernel rule; AR half of Invariant 9 |
| **Governed by** | [ADR-0005](../adr/ADR-0005-central-double-entry-posting-engine.md); [NON_NEGOTIABLES](../NON_NEGOTIABLES.md) rules 1, 11, 12, 14; Invariant 9 |
| **Golden** | P05, P06, P09 |

---

## 1. Trigger

**Posting a customer receipt** — the module's `DRAFT → POSTED` transition by a user holding the receipt-post permission. Money received from a customer, in cash or into the bank, applied in full to that customer's open invoices.

In one transaction the module: validates the draft and its allocations, locks the allocated invoices, calls `postingEngine.post(CUSTOMER_PAYMENT_RECEIVED, …, tx)`, writes the allocations, assigns the receipt number (`RCT-2027-000001`) and sets the receipt `POSTED`.

**Not in the MVP:** cheques (`CHEQUE_RECEIVED` / `CHEQUE_CLEARED`, Wave 3), advances and on-account receipts, over-payments, receipts in any currency but PKR, withholding deducted at source, and settlement discounts. `BANK` in the MVP means funds already in the bank (a transfer or a deposit already made).

## 2. Payload

```ts
{
  event: 'CUSTOMER_PAYMENT_RECEIVED',
  referenceType: 'customer_receipt',
  referenceId: receipt.id,
  occurredAt: receipt.receiptDate,
  idempotencyKey, actor,
  payload: {
    customerId,
    method: 'BANK',                          // 'CASH' | 'BANK'
    amount: '6000.0000',
    allocations: [ { invoiceId, amount: '6000.0000' } ],
  },
}
```

`method` is a business fact — how the money arrived — not an account. The kernel resolves it to a role.

## 3. Preconditions

| # | Rule | Error |
|---|---|---|
| 1 | Schema-valid; amounts are strings, ≤ 4 dp | `PAYLOAD_INVALID`, `AMOUNT_NOT_STRING`, `AMOUNT_SCALE` |
| 2 | `amount > 0` | `AMOUNT_NON_POSITIVE` |
| 3 | At least one allocation; each allocation amount > 0; no invoice listed twice | `RECEIPT_NO_ALLOCATION`, `AMOUNT_NON_POSITIVE`, `ALLOCATION_DUPLICATE_INVOICE` |
| 4 | **`Σ allocations = amount` exactly** — no unallocated remainder | `RECEIPT_UNALLOCATED_AMOUNT` (advances are deferred) |
| 5 | Each invoice: same tenant, **same customer**, status `POSTED` | `INVOICE_NOT_FOUND`, `ALLOCATION_PARTY_MISMATCH`, `INVOICE_NOT_OPEN` |
| 6 | Each invoice's date ≤ the receipt's date | `ALLOCATION_INVOICE_AFTER_RECEIPT` — a receipt before its invoice is an advance |
| 7 | Each allocation ≤ that invoice's outstanding, read **under a row lock** on the invoice | `ALLOCATION_EXCEEDS_OUTSTANDING`, naming the invoice and its outstanding |
| 8 | Customer exists in the tenant and is active | `CUSTOMER_NOT_FOUND`, `CUSTOMER_INACTIVE` |
| 9 | Date ≤ today; resolves to an `OPEN` period | `DATE_IN_FUTURE`, `PERIOD_NOT_FOUND`, `PERIOD_CLOSED`, `PERIOD_LOCKED` |
| 10 | Roles `AR_CONTROL` and `CASH_DEFAULT` or `BANK_DEFAULT` resolve | `ACCOUNT_ROLE_UNMAPPED`, `ACCOUNT_ROLE_MISCONFIGURED` |

Rows 3–7 are the module's subledger rules; the kernel sees only the customer and the amount. They are listed here because they decide whether the GL entry may exist.

**Row 7 and concurrency.** Two receipts allocating to the same invoice at the same moment must not both see the full outstanding. The module takes the invoice rows `FOR UPDATE` in a deterministic order (by invoice id) before computing outstanding; the lock key and position belong in [LOCK_REGISTRY.md](../LOCK_REGISTRY.md) (M3, Database seat).

## 4. Entry

```
Dr CASH_DEFAULT   (method = CASH)        amount
or Dr BANK_DEFAULT   (method = BANK)     amount
    Cr AR_CONTROL   [party: CUSTOMER customerId]        amount
```

With `standard-v1`:

```
JE-2027-000002   2026-09-20   CUSTOMER_PAYMENT_RECEIVED@1   source: customer_receipt RCT-2027-000001
Dr 1120 Bank — Current Account                    6,000.0000
    Cr 1200 Accounts Receivable  [CUST-A]                   6,000.0000
```

**Exactly two lines, whatever the number of allocations.** Allocation to invoices is a subledger fact, not a GL fact: a receipt applied to three invoices is still one debit and one credit. The AR line carries the customer; it does not carry an invoice.

## 5. Allocation — the subledger

Allocations are rows in the receipt module's table (M3): `(tenant_id, receipt_id, invoice_id, amount, status LIVE | VOIDED)`.

```
invoice outstanding = invoice.netAmount − Σ amount of LIVE allocations to it
```

| Case | Result |
|---|---|
| Allocation = outstanding | Invoice fully paid; outstanding `0.0000` |
| Allocation < outstanding | Partial; the remainder stays open (P05: 10,000.0000 − 6,000.0000 = 4,000.0000) |
| Allocation > outstanding | Rejected (row 7) |
| Several invoices | One allocation row each; one GL entry for the receipt |

Allocation is **manual** in the MVP: the user picks invoices and amounts. The UI may pre-fill oldest-first as a suggestion; the server accepts only what is submitted. There is no automatic re-allocation and no un-allocation separate from reversal.

## 6. Amounts

No computation: **no rounding boundary**. The amount and the allocations are user-entered and must agree exactly.

## 7. Reversal

Through the receipt only ([reversal.md](reversal.md) §5). In one transaction:

- kernel reverses the entry: `Dr AR_CONTROL [customer] / Cr CASH_DEFAULT or BANK_DEFAULT`, same amount;
- every allocation of the receipt `LIVE → VOIDED` (never deleted), restoring each invoice's outstanding;
- receipt `POSTED → REVERSED`.

A voided allocation stays visible on both the receipt and the invoice. Reversal date per [reversal.md](reversal.md) §4. A reversed receipt cannot be un-reversed; a corrected receipt is a new document.

## 8. Invariant 9, AR half — the reconciliation this rule makes possible

For every tenant, every customer `C` and every as-of date `D`:

```
GL(C, D)  = Σ (debit − credit) over journal lines on the AR_CONTROL account
            with party C and occurred_at ≤ D        — every entry, POSTED or REVERSED

SUB(C, D) = Σ netAmount of C's invoices posted on or before D
          − Σ netAmount of C's invoices whose reversal is dated on or before D
          − Σ amount of C's receipts posted on or before D
          + Σ amount of C's receipts whose reversal is dated on or before D

GL(C, D) = SUB(C, D)                                  exactly, no tolerance
Σ over C of GL(C, D) = AR_CONTROL balance at D        (structural: README §4.1)
```

And today, because the MVP has no advances:

```
SUB(C, today) = Σ outstanding of C's POSTED invoices
```

The M3 QA lane implements this as Invariant 9 (AR half). A failure is a Sev-2 incident, not a rounding note ([NON_NEGOTIABLES](../NON_NEGOTIABLES.md) §10–11).

## 9. Idempotency

Key per [README](README.md) §4; `source_type = 'customer_receipt'`, `source_id = receipt.id`. Replay returns the original entry; a second post of the same receipt under a new key is `SOURCE_ALREADY_POSTED`. Allocations are written in the same transaction, so a replay never writes them twice.

## 10. Edge cases

| Case | Behaviour |
|---|---|
| Customer pays more than is owed | Rejected in the MVP (`RECEIPT_UNALLOCATED_AMOUNT`). The user records what is owed; the excess waits for advances |
| Receipt dated in a closed period | `PERIOD_CLOSED`; re-date. Never redirected |
| Invoice reversed between loading the form and posting | `INVOICE_NOT_OPEN` |
| Receipt for an invoice whose period is closed | Allowed. The receipt's own date governs its period |
| Cash receipt taking Cash in Hand from negative to positive | No effect on the rule. Negative-cash controls are not in the MVP |

## 11. Errors

`PAYLOAD_INVALID` · `AMOUNT_NOT_STRING` · `AMOUNT_SCALE` · `AMOUNT_NON_POSITIVE` · `RECEIPT_NO_ALLOCATION` · `ALLOCATION_DUPLICATE_INVOICE` · `RECEIPT_UNALLOCATED_AMOUNT` · `INVOICE_NOT_FOUND` · `ALLOCATION_PARTY_MISMATCH` · `INVOICE_NOT_OPEN` · `ALLOCATION_INVOICE_AFTER_RECEIPT` · `ALLOCATION_EXCEEDS_OUTSTANDING` · `CUSTOMER_NOT_FOUND` · `CUSTOMER_INACTIVE` · `DATE_IN_FUTURE` · `PERIOD_NOT_FOUND` · `PERIOD_CLOSED` · `PERIOD_LOCKED` · `ACCOUNT_ROLE_UNMAPPED` · `ACCOUNT_ROLE_MISCONFIGURED` · `SOURCE_ALREADY_POSTED` · `IDEMPOTENCY_KEY_REUSED`

## 12. Golden

**P05** (6,000.0000 against 10,000.0000; ledger 4,000.0000; allocation rejections), **P06** (receipt reversal restores outstanding), **P09** (journey).
