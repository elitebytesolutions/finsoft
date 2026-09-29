import { z } from 'zod'

/*
 * Framework-free HTTP request schemas. docs/design/M3/api-contract.md §1,
 * §4.1. `.strict()` on every envelope: an unknown key (including `tenantId`
 * or `code`) is `VALIDATION_FAILED`, never silently dropped (ADR-0004
 * rule 2). Business-rule validation (length, ntn shape, creditDays range)
 * still happens in `domain/customer.ts` — these schemas check only the
 * ENVELOPE shape and the one thing the domain deliberately leaves to the
 * boundary: email format (api-contract.md §4.1).
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const nullableString = z
  .string()
  .nullish()
  .transform((v) => v ?? null)

const emailField = z
  .string()
  .refine((v) => EMAIL_SHAPE.test(v), { message: 'email must look like an email address.' })
  .nullish()
  .transform((v) => v ?? null)

export const CreateCustomerSchema = z
  .object({
    name: z.string({ invalid_type_error: 'name must be a string' }),
    phone: nullableString,
    email: emailField,
    address: nullableString,
    city: nullableString,
    ntn: nullableString,
    creditDays: z.number({ invalid_type_error: 'creditDays must be a number' }).int(),
  })
  .strict()
export type CreateCustomerDto = z.infer<typeof CreateCustomerSchema>

export const UpdateCustomerSchema = z
  .object({
    version: z.number({ invalid_type_error: 'version must be a number' }).int(),
    name: z.string().optional(),
    phone: z.string().nullable().optional(),
    email: z
      .string()
      .refine((v) => EMAIL_SHAPE.test(v), { message: 'email must look like an email address.' })
      .nullable()
      .optional(),
    address: z.string().nullable().optional(),
    city: z.string().nullable().optional(),
    ntn: z.string().nullable().optional(),
    creditDays: z.number().int().optional(),
  })
  .strict()
export type UpdateCustomerDto = z.infer<typeof UpdateCustomerSchema>

export const VersionOnlySchema = z
  .object({ version: z.number({ invalid_type_error: 'version must be a number' }).int() })
  .strict()
export type VersionOnlyDto = z.infer<typeof VersionOnlySchema>

export const ListCustomersQuerySchema = z
  .object({
    q: z.string().min(1).optional(),
    status: z
      .union([z.enum(['ACTIVE', 'INACTIVE']), z.array(z.enum(['ACTIVE', 'INACTIVE']))])
      .optional()
      .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().optional(),
  })
  .strict()
export type ListCustomersQueryDto = z.infer<typeof ListCustomersQuerySchema>

export const CustomerLedgerQuerySchema = z
  .object({
    from: z.string().regex(ISO_DATE, 'from must be a calendar date, YYYY-MM-DD').optional(),
    to: z.string().regex(ISO_DATE, 'to must be a calendar date, YYYY-MM-DD').optional(),
  })
  .strict()
export type CustomerLedgerQueryDto = z.infer<typeof CustomerLedgerQuerySchema>
