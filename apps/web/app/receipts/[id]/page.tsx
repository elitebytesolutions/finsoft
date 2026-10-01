'use client'
/*
 * Route /receipts/:id — M4-W2, new. ReceiptDetail is self-contained (fetches by this id
 * itself), same pattern as CustomerDetail/SaleDetail — no <Guard>, its own
 * can('payment.receive' / 'voucher.reverse') plus the server's 403 are the access control.
 */
import { ReceiptDetail } from '@/screens/detail-pages'

export default function Page() {
  return <ReceiptDetail />
}
