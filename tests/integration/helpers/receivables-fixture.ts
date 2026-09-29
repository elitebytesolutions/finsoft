import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import type { CustomersTenantFixture } from './customers-fixture.ts'

/*
 * Small HTTP helpers shared by tests/integration/receivables/*.spec.ts.
 * Reuses tests/integration/helpers/customers-fixture.ts's
 * `createCustomersTenant` — an owner with EVERY MVP permission (including
 * invoice.create, invoice.post, payment.receive, voucher.reverse), a
 * viewer with customer.view only, and a no-role user, on a tenant with
 * standard-v1 COA and FY2027 already seeded (so AR_CONTROL / SERVICE_REVENUE
 * / CASH_DEFAULT / BANK_DEFAULT all resolve).
 */

const TEST_TENANT_HEADER = 'x-test-tenant-id'
const TEST_USER_HEADER = 'x-test-user-id'

export function authHeaders(tenantId: string, userId: string): Record<string, string> {
  return { [TEST_TENANT_HEADER]: tenantId, [TEST_USER_HEADER]: userId }
}
export const asOwner = (t: CustomersTenantFixture) => authHeaders(t.tenantId, t.ownerId)
export const asViewer = (t: CustomersTenantFixture) => authHeaders(t.tenantId, t.viewerId)
export const asNoRole = (t: CustomersTenantFixture) => authHeaders(t.tenantId, t.noRoleId)

let keyCounter = 0
export function idemKey(prefix = 'rcv-test'): string {
  keyCounter += 1
  return `${prefix}-${keyCounter}-${Date.now()}`
}

export function customerBody(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    name: 'Bhatti Traders',
    phone: '0300-1234567',
    email: null,
    address: null,
    city: 'Lahore',
    ntn: null,
    creditDays: 30,
    ...overrides,
  }
}

/** Creates an ACTIVE customer for `tenant` and returns its id. */
export async function createCustomer(
  app: INestApplication,
  tenant: CustomersTenantFixture,
  overrides: Partial<Record<string, unknown>> = {},
): Promise<{ id: string; code: string }> {
  const res = await request(app.getHttpServer())
    .post('/api/customers')
    .set(asOwner(tenant))
    .set('Idempotency-Key', idemKey('cust'))
    .send(customerBody(overrides))
    .expect(201)
  return { id: res.body.id as string, code: res.body.code as string }
}

export interface DraftInvoiceLine {
  readonly description: string
  readonly quantity: string
  readonly unitPrice: string
}

/** Creates and posts a service invoice; returns its full response body. */
export async function createPostedInvoice(
  app: INestApplication,
  tenant: CustomersTenantFixture,
  customerId: string,
  lines: readonly DraftInvoiceLine[] = [
    { description: 'Monthly maintenance', quantity: '1.000000', unitPrice: '7500.000000' },
    { description: 'Site visit', quantity: '3.000000', unitPrice: '833.333333' },
  ],
  invoiceDate?: string,
): Promise<Record<string, unknown>> {
  const draft = await request(app.getHttpServer())
    .post('/api/invoices')
    .set(asOwner(tenant))
    .set('Idempotency-Key', idemKey('inv-draft'))
    .send({ customerId, ...(invoiceDate ? { invoiceDate } : {}), narration: null, lines })
    .expect(201)

  const posted = await request(app.getHttpServer())
    .post(`/api/invoices/${draft.body.id}/post`)
    .set(asOwner(tenant))
    .set('Idempotency-Key', idemKey('inv-post'))
    .send({ version: draft.body.version })
    .expect(200)

  return posted.body as Record<string, unknown>
}
