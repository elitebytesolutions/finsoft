'use client'
/*
 * Route /sales/voucher — M4-W2: real API (I1–I8). Self-contained, same pattern as
 * CustomerDetail/AccountLedger — no <Guard> (its own can('invoice.create') plus the server's
 * 403 are the access control), no mock data/onAdd props.
 */
import { SalesVoucher } from '@/screens/sales-voucher'

export default function Page() {
  return <SalesVoucher />
}
