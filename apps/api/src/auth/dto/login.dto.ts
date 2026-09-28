import { z } from 'zod'

/*
 * POST /api/auth/login. ADR-0023 §1.
 *
 * `tenantCode` is the ONE place a tenant may appear in a request body in
 * this codebase (ADR-0023 §1, Council ruling 2026-09-27) — it selects which
 * global `tenants` row to resolve against, and a wrong code fails identically
 * to a wrong password (§4 item 4). It is never used to set `app.tenant_id`
 * directly: only the resolver inside `withResolvedTenant` may do that
 * (packages/database/src/transaction.ts).
 *
 * `tenants.code` is upper-case-only by its own CHECK constraint
 * (`001_create_tenants.sql`); this schema upper-cases defensively so
 * `bhatti1` and `BHATTI1` are one budget in the throttle layers, not two.
 */
export const LoginSchema = z.object({
  tenantCode: z
    .string()
    .trim()
    .min(2)
    .max(16)
    .regex(/^[A-Za-z][A-Za-z0-9_]{1,15}$/, 'tenantCode must match ^[A-Z][A-Z0-9_]{1,15}$')
    .transform((value) => value.toUpperCase()),
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string().min(1).max(512),
})

export type LoginDto = z.infer<typeof LoginSchema>
