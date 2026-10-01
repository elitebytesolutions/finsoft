import { z } from 'zod'

/*
 * Framework-free HTTP request schemas. docs/design/M3/api-contract.md §1,
 * §4.2, §4.3. `.strict()` on every envelope: an unknown key (including
 * `tenantId`) is `VALIDATION_FAILED`, never silently dropped. Money,
 * quantity and unit-price fields are checked here only for SHAPE (a
 * string); scale/notation/positivity is the domain's job
 * (AMOUNT_NOT_STRING/AMOUNT_SCALE/SALE_LINE_NON_POSITIVE, etc.) so the same
 * `Money`/`Quantity`/`UnitCost` parse governs every entry point exactly
 * once (ADR-0011/ADR-0014 "parse once").
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const amountString = z.string({ invalid_type_error: 'must be a decimal string, not a number' })
const nullableAmountString = amountString.nullish().transform((v) => v ?? null)
const nullableString = z
  .string()
  .nullish()
  .transform((v) => v ?? null)
const dateString = z.string().regex(ISO_DATE, 'must be a calendar date, YYYY-MM-DD')

const InvoiceLineSchema = z
  .object({
    description: z.string({ invalid_type_error: 'description must be a string' }),
    quantity: amountString,
    unitPrice: amountString,
  })
  .strict()

export const CreateInvoiceSchema = z
  .object({
    customerId: z.string().uuid(),
    invoiceDate: dateString.optional(),
    dueDate: dateString.nullish().transform((v) => v ?? null),
    narration: nullableString,
    lines: z.array(InvoiceLineSchema).max(200),
  })
  .strict()
export type CreateInvoiceDto = z.infer<typeof CreateInvoiceSchema>

export const UpdateInvoiceSchema = CreateInvoiceSchema.extend({
  version: z.number({ invalid_type_error: 'version must be a number' }).int(),
}).strict()
export type UpdateInvoiceDto = z.infer<typeof UpdateInvoiceSchema>

export const CalculateInvoiceSchema = z
  .object({ lines: z.array(InvoiceLineSchema).max(1000) })
  .strict()
export type CalculateInvoiceDto = z.infer<typeof CalculateInvoiceSchema>

export const InvoiceVersionOnlySchema = z
  .object({ version: z.number({ invalid_type_error: 'version must be a number' }).int() })
  .strict()
export type InvoiceVersionOnlyDto = z.infer<typeof InvoiceVersionOnlySchema>

export const ReasonSchema = z
  .object({ reason: z.string({ invalid_type_error: 'reason must be a string' }) })
  .strict()
export type ReasonDto = z.infer<typeof ReasonSchema>

const INVOICE_STATUS = ['DRAFT', 'POSTED', 'REVERSED', 'CANCELLED'] as const
export const ListInvoicesQuerySchema = z
  .object({
    customerId: z.string().uuid().optional(),
    status: z
      .union([z.enum(INVOICE_STATUS), z.array(z.enum(INVOICE_STATUS))])
      .optional()
      .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])),
    open: z.coerce.boolean().optional(),
    from: dateString.optional(),
    to: dateString.optional(),
    q: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().optional(),
  })
  .strict()
export type ListInvoicesQueryDto = z.infer<typeof ListInvoicesQuerySchema>

const AllocationSchema = z.object({ invoiceId: z.string().uuid(), amount: amountString }).strict()

export const CreateReceiptSchema = z
  .object({
    customerId: z.string().uuid(),
    receiptDate: dateString.optional(),
    method: z
      .enum(['CASH', 'BANK'])
      .nullish()
      .transform((v) => v ?? null),
    amount: nullableAmountString,
    reference: nullableString,
    narration: nullableString,
    allocations: z.array(AllocationSchema).optional().default([]),
  })
  .strict()
export type CreateReceiptDto = z.infer<typeof CreateReceiptSchema>

export const UpdateReceiptSchema = z
  .object({
    version: z.number({ invalid_type_error: 'version must be a number' }).int(),
    customerId: z.string().uuid().optional(),
    receiptDate: dateString.optional(),
    method: z.enum(['CASH', 'BANK']).nullable().optional(),
    amount: amountString.nullable().optional(),
    reference: z.string().nullable().optional(),
    narration: z.string().nullable().optional(),
    allocations: z.array(AllocationSchema).optional(),
  })
  .strict()
export type UpdateReceiptDto = z.infer<typeof UpdateReceiptSchema>

export const PreviewReceiptSchema = z
  .object({
    customerId: z.string().uuid().optional(),
    receiptId: z.string().uuid().optional(),
    receiptDate: dateString.optional(),
    amount: amountString.optional(),
    allocations: z.array(AllocationSchema).optional(),
  })
  .strict()
export type PreviewReceiptDto = z.infer<typeof PreviewReceiptSchema>

export const ReceiptVersionOnlySchema = z
  .object({ version: z.number({ invalid_type_error: 'version must be a number' }).int() })
  .strict()
export type ReceiptVersionOnlyDto = z.infer<typeof ReceiptVersionOnlySchema>

const RECEIPT_STATUS = ['DRAFT', 'POSTED', 'REVERSED', 'CANCELLED'] as const
export const ListReceiptsQuerySchema = z
  .object({
    customerId: z.string().uuid().optional(),
    status: z
      .union([z.enum(RECEIPT_STATUS), z.array(z.enum(RECEIPT_STATUS))])
      .optional()
      .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])),
    method: z.enum(['CASH', 'BANK']).optional(),
    from: dateString.optional(),
    to: dateString.optional(),
    q: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().optional(),
  })
  .strict()
export type ListReceiptsQueryDto = z.infer<typeof ListReceiptsQuerySchema>
