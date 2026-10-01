'use client'
/*
 * Route /payments — M4-W2: real customer receipts (R1-R8). Self-contained, same pattern as
 * CustomerDetail/SalesVoucher — no <Guard> (its own can('payment.receive') plus the server's
 * 403 are the access control), no mock data/onAddPayment props.
 */
import { PaymentsCentre } from '@/screens/transactions-pages'

export default function Page() {
  return <PaymentsCentre />
}
