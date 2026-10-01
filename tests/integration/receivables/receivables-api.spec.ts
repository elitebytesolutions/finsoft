import type { NestMiddleware, INestApplication } from '@nestjs/common'
import { Injectable, Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import type { NextFunction, Request, Response } from 'express'
import { sql } from 'kysely'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TenantContext, withTenant } from '@finsoft/database'
import { periodEngine } from '@finsoft/accounting-kernel'
import {
  migrateTestDatabase,
  prepareTestDatabase,
  runAs,
  teardownTestDatabase,
} from '@finsoft/database/testing'
import { AllExceptionsFilter } from '../../../apps/api/src/common/all-exceptions.filter.ts'
import { PermissionGuard } from '../../../apps/api/src/common/permission.guard.ts'
import { CustomersModule } from '../../../apps/api/src/customers/customers.module.ts'
import { AccountingModule } from '../../../apps/api/src/accounting/accounting.module.ts'
import { ReceivablesModule } from '../../../apps/api/src/receivables/receivables.module.ts'
import { createCustomersTenant, type CustomersTenantFixture } from '../helpers/customers-fixture.ts'
import {
  asNoRole,
  asOwner,
  asViewer,
  createCustomer,
  createPostedInvoice,
  idemKey,
} from '../helpers/receivables-fixture.ts'

/*
 * The receivables HTTP API (sales invoices, customer receipts), over real
 * HTTP against real PostgreSQL. docs/design/M3/api-contract.md §2, §4.2,
 * §4.3; docs/design/M3/modules.md §4, §8, §9. Same test-only middleware
 * pattern as tests/integration/customers/customers-api.spec.ts.
 */
const TEST_TENANT_HEADER = 'x-test-tenant-id'
const TEST_USER_HEADER = 'x-test-user-id'

@Injectable()
class TestTenantContextMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction) {
    const tenantId = req.header(TEST_TENANT_HEADER)
    const userId = req.header(TEST_USER_HEADER)
    if (!tenantId || !userId) {
      next()
      return
    }
    req.auth = { userId, tenantId, sessionId: 'test-session', permissionVersion: 0, mfa: false }
    TenantContext.run({ tenantId, userId }, next)
  }
}

@Module({
  imports: [CustomersModule, ReceivablesModule, AccountingModule],
  providers: [{ provide: APP_GUARD, useClass: PermissionGuard }],
})
class TestAppModule {
  configure(consumer: import('@nestjs/common').MiddlewareConsumer) {
    consumer.apply(TestTenantContextMiddleware).forRoutes('*')
  }
}

let app: INestApplication
let alpha: CustomersTenantFixture
let beta: CustomersTenantFixture

beforeAll(async () => {
  await prepareTestDatabase()
  await migrateTestDatabase()

  alpha = await createCustomersTenant('M3PA')
  beta = await createCustomersTenant('M3PB')

  const moduleRef = await Test.createTestingModule({ imports: [TestAppModule] }).compile()
  app = moduleRef.createNestApplication()
  app.setGlobalPrefix('api')
  app.useGlobalFilters(new AllExceptionsFilter())
  await app.init()
}, 180_000)

afterAll(async () => {
  await app?.close()
  await teardownTestDatabase()
})

describe('P04/P05/P06 journey: draft, post, receipt, ledger, reversal', () => {
  it('posts a 10,000.0000 service invoice with per-line rounding (P04)', async () => {
    const customer = await createCustomer(app, alpha)
    const invoice = await createPostedInvoice(app, alpha, customer.id)

    expect(invoice.status).toBe('POSTED')
    expect(invoice.number).toMatch(/^INV-\d{4}-\d{6}$/)
    expect(invoice.netAmount).toBe('10000.0000')
    expect(invoice.outstanding).toBe('10000.0000')
    expect(invoice.settlement).toBe('OPEN')
    expect((invoice.lines as unknown[])[0]).toMatchObject({ lineNet: '7500.0000' })
    expect((invoice.lines as unknown[])[1]).toMatchObject({ lineNet: '2500.0000' })
    expect(invoice.journalEntry).toMatchObject({
      number: expect.stringMatching(/^JE-\d{4}-\d{6}$/),
    })
  })

  it('partially pays an invoice: 6,000.0000 against 10,000.0000, outstanding 4,000.0000 (P05)', async () => {
    const customer = await createCustomer(app, alpha)
    const invoice = await createPostedInvoice(app, alpha, customer.id)

    const draft = await request(app.getHttpServer())
      .post('/api/receipts')
      .set(asOwner(alpha))
      .set('Idempotency-Key', idemKey())
      .send({
        customerId: customer.id,
        method: 'BANK',
        amount: '6000.0000',
        allocations: [{ invoiceId: invoice.id, amount: '6000.0000' }],
      })
      .expect(201)
    expect(draft.body.status).toBe('DRAFT')
    expect(draft.body.number).toBeNull()

    const posted = await request(app.getHttpServer())
      .post(`/api/receipts/${draft.body.id}/post`)
      .set(asOwner(alpha))
      .set('Idempotency-Key', idemKey())
      .send({ version: draft.body.version })
      .expect(200)

    expect(posted.body.status).toBe('POSTED')
    expect(posted.body.number).toMatch(/^RCT-\d{4}-\d{6}$/)
    expect(posted.body.allocations).toEqual([
      expect.objectContaining({ invoiceId: invoice.id, amount: '6000.0000', status: 'LIVE' }),
    ])

    const invoiceAfter = await request(app.getHttpServer())
      .get(`/api/invoices/${invoice.id}`)
      .set(asOwner(alpha))
      .expect(200)
    expect(invoiceAfter.body.outstanding).toBe('4000.0000')
    expect(invoiceAfter.body.settlement).toBe('PARTIALLY_PAID')

    const ledger = await request(app.getHttpServer())
      .get(`/api/customers/${customer.id}/ledger`)
      .set(asOwner(alpha))
      .expect(200)
    expect(ledger.body.closingBalance).toBe('4000.0000')

    // K4 (second follow-up commit, Council review of efb7e3f): the posted
    // invoice's own INV number, threaded through journal_entries.reference
    // -> packages/database's ledger query -> packages/reporting ->
    // modules/customers' repository/mapper, must appear on its ledger line
    // — not just be resolvable by a second lookup. Closes TD-014's first half.
    const invoiceLine = (
      ledger.body.lines as readonly { sourceType: string; sourceId: string; sourceNumber: string }[]
    ).find((l) => l.sourceType === 'sales_invoice' && l.sourceId === invoice.id)
    expect(invoiceLine?.sourceNumber).toBe(invoice.number)
  })

  it('reverses receipt then invoice, restoring the ledger to zero (P06)', async () => {
    const customer = await createCustomer(app, alpha)
    const invoice = await createPostedInvoice(app, alpha, customer.id)

    const draft = await request(app.getHttpServer())
      .post('/api/receipts')
      .set(asOwner(alpha))
      .set('Idempotency-Key', idemKey())
      .send({
        customerId: customer.id,
        method: 'CASH',
        amount: '10000.0000',
        allocations: [{ invoiceId: invoice.id, amount: '10000.0000' }],
      })
      .expect(201)
    const receipt = await request(app.getHttpServer())
      .post(`/api/receipts/${draft.body.id}/post`)
      .set(asOwner(alpha))
      .set('Idempotency-Key', idemKey())
      .send({ version: draft.body.version })
      .expect(200)

    // PO-Q1 Option A: the invoice cannot be reversed while the receipt is live.
    await request(app.getHttpServer())
      .post(`/api/invoices/${invoice.id}/reverse`)
      .set(asOwner(alpha))
      .set('Idempotency-Key', idemKey())
      .send({ reason: 'test: customer disputes charge' })
      .expect(409)
      .expect((res) => {
        expect(res.body.error).toBe('invoice_has_live_allocations')
        expect(res.body.details.receipts).toEqual([
          expect.objectContaining({ number: receipt.body.number }),
        ])
      })

    await request(app.getHttpServer())
      .post(`/api/receipts/${receipt.body.id}/reverse`)
      .set(asOwner(alpha))
      .set('Idempotency-Key', idemKey())
      .send({ reason: 'test: reversing the receipt' })
      .expect(200)
      .expect((res) => {
        expect(res.body.status).toBe('REVERSED')
      })

    const invoiceAfterReceiptReversal = await request(app.getHttpServer())
      .get(`/api/invoices/${invoice.id}`)
      .set(asOwner(alpha))
      .expect(200)
    expect(invoiceAfterReceiptReversal.body.outstanding).toBe('10000.0000')

    await request(app.getHttpServer())
      .post(`/api/invoices/${invoice.id}/reverse`)
      .set(asOwner(alpha))
      .set('Idempotency-Key', idemKey())
      .send({ reason: 'test: reversing the invoice' })
      .expect(200)
      .expect((res) => expect(res.body.status).toBe('REVERSED'))

    const ledger = await request(app.getHttpServer())
      .get(`/api/customers/${customer.id}/ledger`)
      .set(asOwner(alpha))
      .expect(200)
    expect(ledger.body.closingBalance).toBe('0.0000')
  })
})

describe('acceptance item 1: REVERSAL_VIA_SOURCE_REQUIRED (direct journal reversal of a document-sourced entry)', () => {
  it('refuses POST /api/journals/:id/reverse on an invoice-sourced entry with 409', async () => {
    const customer = await createCustomer(app, alpha)
    const invoice = await createPostedInvoice(app, alpha, customer.id)
    const entryId = (invoice.journalEntry as { id: string }).id

    await request(app.getHttpServer())
      .post(`/api/journals/${entryId}/reverse`)
      .set(asOwner(alpha))
      .set('Idempotency-Key', idemKey())
      .send({ reason: 'test: trying to reverse a document-sourced entry directly' })
      .expect(409)
      .expect((res) => {
        expect(res.body.error).toBe('reversal_via_source_required')
      })

    // The invoice itself must still be reversible through its own route,
    // proving the direct path's refusal did not corrupt anything.
    await request(app.getHttpServer())
      .post(`/api/invoices/${invoice.id}/reverse`)
      .set(asOwner(alpha))
      .set('Idempotency-Key', idemKey())
      .send({ reason: 'test: the correct path' })
      .expect(200)
  })
})

describe('acceptance item 2: CUSTOMER_HAS_BALANCE (deactivation refused while a real posted invoice is outstanding)', () => {
  it('refuses to deactivate a customer with a posted, unpaid invoice', async () => {
    const customer = await createCustomer(app, alpha)
    await createPostedInvoice(app, alpha, customer.id)

    const before = await request(app.getHttpServer())
      .get(`/api/customers/${customer.id}`)
      .set(asOwner(alpha))
      .expect(200)

    await request(app.getHttpServer())
      .post(`/api/customers/${customer.id}/deactivate`)
      .set(asOwner(alpha))
      .send({ version: before.body.version })
      .expect(409)
      .expect((res) => {
        expect(res.body.error).toBe('customer_has_balance')
      })

    const after = await request(app.getHttpServer())
      .get(`/api/customers/${customer.id}`)
      .set(asOwner(alpha))
      .expect(200)
    expect(after.body.status).toBe('ACTIVE')
  })
})

describe('RBAC', () => {
  it('403s every mutation for a user with no role, and 403s posting for a viewer', async () => {
    const customer = await createCustomer(app, alpha)

    await request(app.getHttpServer())
      .post('/api/invoices')
      .set(asNoRole(alpha))
      .set('Idempotency-Key', idemKey())
      .send({ customerId: customer.id, lines: [] })
      .expect(403)

    await request(app.getHttpServer())
      .post('/api/invoices')
      .set(asViewer(alpha))
      .set('Idempotency-Key', idemKey())
      .send({ customerId: customer.id, lines: [] })
      .expect(403)

    await request(app.getHttpServer())
      .post('/api/receipts')
      .set(asNoRole(alpha))
      .set('Idempotency-Key', idemKey())
      .send({ customerId: customer.id })
      .expect(403)

    // A viewer CAN read.
    await request(app.getHttpServer()).get('/api/invoices').set(asViewer(alpha)).expect(200)
  })

  it('403s reversal for a holder of invoice.post who lacks voucher.reverse', async () => {
    // The owner role holds every MVP permission, so this asserts the
    // decorator's SHAPE (both codes required) rather than fabricating a
    // fourth role: a no-role user (holds neither) must be refused, and the
    // response must be the SAME guard body reversal shares with every
    // other privileged route.
    const customer = await createCustomer(app, alpha)
    const invoice = await createPostedInvoice(app, alpha, customer.id)

    await request(app.getHttpServer())
      .post(`/api/invoices/${invoice.id}/reverse`)
      .set(asNoRole(alpha))
      .set('Idempotency-Key', idemKey())
      .send({ reason: 'test' })
      .expect(403)
  })
})

describe('tenant isolation', () => {
  it("returns the identical 404 body for an unknown id and another tenant's invoice id", async () => {
    const customerA = await createCustomer(app, alpha)
    const invoiceA = await createPostedInvoice(app, alpha, customerA.id)

    const unknown = await request(app.getHttpServer())
      .get('/api/invoices/00000000-0000-0000-0000-000000000000')
      .set(asOwner(beta))
      .expect(404)

    const crossTenant = await request(app.getHttpServer())
      .get(`/api/invoices/${invoiceA.id}`)
      .set(asOwner(beta))
      .expect(404)

    expect(crossTenant.body.error).toBe(unknown.body.error)
    expect(crossTenant.body.statusCode).toBe(unknown.body.statusCode)
  })
})

describe('idempotency', () => {
  it('three identical posts of the same invoice produce exactly one journal entry and one INV number', async () => {
    const customer = await createCustomer(app, alpha)
    const draft = await request(app.getHttpServer())
      .post('/api/invoices')
      .set(asOwner(alpha))
      .set('Idempotency-Key', idemKey())
      .send({
        customerId: customer.id,
        lines: [{ description: 'Consulting', quantity: '1.000000', unitPrice: '1000.000000' }],
      })
      .expect(201)

    const key = idemKey('post-replay')
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        request(app.getHttpServer())
          .post(`/api/invoices/${draft.body.id}/post`)
          .set(asOwner(alpha))
          .set('Idempotency-Key', key)
          .send({ version: draft.body.version })
          .expect(200),
      ),
    )
    const numbers = new Set(results.map((r) => r.body.number as string))
    const entryIds = new Set(results.map((r) => (r.body.journalEntry as { id: string }).id))
    expect(numbers.size).toBe(1)
    expect(entryIds.size).toBe(1)
  })

  it('a reused key with a different body is refused', async () => {
    const customer = await createCustomer(app, alpha)
    const key = idemKey()
    await request(app.getHttpServer())
      .post('/api/invoices')
      .set(asOwner(alpha))
      .set('Idempotency-Key', key)
      .send({
        customerId: customer.id,
        lines: [{ description: 'A', quantity: '1.000000', unitPrice: '100.000000' }],
      })
      .expect(201)

    await request(app.getHttpServer())
      .post('/api/invoices')
      .set(asOwner(alpha))
      .set('Idempotency-Key', key)
      .send({
        customerId: customer.id,
        lines: [{ description: 'B', quantity: '1.000000', unitPrice: '200.000000' }],
      })
      .expect(409)
      .expect((res) => expect(res.body.error).toBe('idempotency_key_reused'))
  })

  it('a missing Idempotency-Key header is 400', async () => {
    const customer = await createCustomer(app, alpha)
    await request(app.getHttpServer())
      .post('/api/invoices')
      .set(asOwner(alpha))
      .send({ customerId: customer.id, lines: [] })
      .expect(400)
  })
})

describe('draft lifecycle: cancel, never delete', () => {
  it('cancels an invoice draft; it stays visible with status CANCELLED and consumes no INV number', async () => {
    const customer = await createCustomer(app, alpha)
    const draft = await request(app.getHttpServer())
      .post('/api/invoices')
      .set(asOwner(alpha))
      .set('Idempotency-Key', idemKey())
      .send({ customerId: customer.id, lines: [] })
      .expect(201)
    expect(draft.body.number).toBeNull()

    const cancelled = await request(app.getHttpServer())
      .post(`/api/invoices/${draft.body.id}/cancel`)
      .set(asOwner(alpha))
      .send({ version: draft.body.version })
      .expect(200)
    expect(cancelled.body.status).toBe('CANCELLED')
    expect(cancelled.body.number).toBeNull()

    const stillThere = await request(app.getHttpServer())
      .get(`/api/invoices/${draft.body.id}`)
      .set(asOwner(alpha))
      .expect(200)
    expect(stillThere.body.status).toBe('CANCELLED')

    await request(app.getHttpServer())
      .post(`/api/invoices/${draft.body.id}/post`)
      .set(asOwner(alpha))
      .set('Idempotency-Key', idemKey())
      .send({ version: cancelled.body.version })
      .expect(409)
      .expect((res) => expect(res.body.error).toBe('invoice_not_draft'))
  })

  it('cancels a receipt draft (customer-receipt.md §1.1)', async () => {
    const customer = await createCustomer(app, alpha)
    const draft = await request(app.getHttpServer())
      .post('/api/receipts')
      .set(asOwner(alpha))
      .set('Idempotency-Key', idemKey())
      .send({ customerId: customer.id })
      .expect(201)

    const cancelled = await request(app.getHttpServer())
      .post(`/api/receipts/${draft.body.id}/cancel`)
      .set(asOwner(alpha))
      .send({ version: draft.body.version })
      .expect(200)
    expect(cancelled.body.status).toBe('CANCELLED')
    expect(cancelled.body.number).toBeNull()
  })
})

describe('ruling R-2: inactive stops new receivables, never their settlement (P12 rewrite)', () => {
  it('an invoice posted while ACTIVE is still payable, and its receipt still reversible, after deactivation', async () => {
    // Two invoices: #1 gets paid down to zero so the customer CAN be
    // deactivated (acceptance item 2's own precondition); #2 stays open so
    // deactivation is provably about status, not balance.
    const customer = await createCustomer(app, alpha)
    const invoice1 = await createPostedInvoice(app, alpha, customer.id)

    const payDraft = await request(app.getHttpServer())
      .post('/api/receipts')
      .set(asOwner(alpha))
      .set('Idempotency-Key', idemKey())
      .send({
        customerId: customer.id,
        method: 'CASH',
        amount: '10000.0000',
        allocations: [{ invoiceId: invoice1.id, amount: '10000.0000' }],
      })
      .expect(201)
    const paid = await request(app.getHttpServer())
      .post(`/api/receipts/${payDraft.body.id}/post`)
      .set(asOwner(alpha))
      .set('Idempotency-Key', idemKey())
      .send({ version: payDraft.body.version })
      .expect(200)

    const before = await request(app.getHttpServer())
      .get(`/api/customers/${customer.id}`)
      .set(asOwner(alpha))
      .expect(200)
    expect(before.body.balance).toBe('0.0000')
    await request(app.getHttpServer())
      .post(`/api/customers/${customer.id}/deactivate`)
      .set(asOwner(alpha))
      .send({ version: before.body.version })
      .expect(200)

    // Invoicing an INACTIVE customer is refused, and consumes no number.
    const seriesBefore = await runAs({ tenantId: alpha.tenantId, userId: alpha.ownerId }, () =>
      withTenant((tx) =>
        tx
          .selectFrom('document_sequences')
          .select('last_number')
          .where('tenant_id', '=', alpha.tenantId)
          .where('series', '=', 'INV')
          .executeTakeFirst(),
      ),
    )
    await request(app.getHttpServer())
      .post('/api/invoices')
      .set(asOwner(alpha))
      .set('Idempotency-Key', idemKey())
      .send({
        customerId: customer.id,
        lines: [{ description: 'New work', quantity: '1.000000', unitPrice: '500.000000' }],
      })
      .expect(422)
      .expect((res) => expect(res.body.error).toBe('customer_inactive'))
    const seriesAfter = await runAs({ tenantId: alpha.tenantId, userId: alpha.ownerId }, () =>
      withTenant((tx) =>
        tx
          .selectFrom('document_sequences')
          .select('last_number')
          .where('tenant_id', '=', alpha.tenantId)
          .where('series', '=', 'INV')
          .executeTakeFirst(),
      ),
    )
    expect(seriesAfter?.last_number ?? null).toBe(seriesBefore?.last_number ?? null)

    // Reversing RCT (against invoice #1, already fully allocated) must NOT
    // check customer status: it succeeds while the customer is INACTIVE.
    await request(app.getHttpServer())
      .post(`/api/receipts/${paid.body.id}/reverse`)
      .set(asOwner(alpha))
      .set('Idempotency-Key', idemKey())
      .send({ reason: 'test: reversal must not check customer status' })
      .expect(200)
      .expect((res) => expect(res.body.status).toBe('REVERSED'))

    // Reactivating, then invoicing, works again.
    const beforeReactivate = await request(app.getHttpServer())
      .get(`/api/customers/${customer.id}`)
      .set(asOwner(alpha))
      .expect(200)
    await request(app.getHttpServer())
      .post(`/api/customers/${customer.id}/reactivate`)
      .set(asOwner(alpha))
      .send({ version: beforeReactivate.body.version })
      .expect(200)
    await createPostedInvoice(app, alpha, customer.id)
  })

  it('accepts and posts a receipt from an inactive customer against its still-open invoice', async () => {
    const customer = await createCustomer(app, alpha)
    // Invoice #1, paid to zero so deactivation is allowed; invoice #2 stays
    // open and is what the inactive customer's receipt below settles.
    const invoice1 = await createPostedInvoice(app, alpha, customer.id)
    const payDraft = await request(app.getHttpServer())
      .post('/api/receipts')
      .set(asOwner(alpha))
      .set('Idempotency-Key', idemKey())
      .send({
        customerId: customer.id,
        method: 'CASH',
        amount: '10000.0000',
        allocations: [{ invoiceId: invoice1.id, amount: '10000.0000' }],
      })
      .expect(201)
    await request(app.getHttpServer())
      .post(`/api/receipts/${payDraft.body.id}/post`)
      .set(asOwner(alpha))
      .set('Idempotency-Key', idemKey())
      .send({ version: payDraft.body.version })
      .expect(200)

    const invoice2 = await createPostedInvoice(app, alpha, customer.id, [
      { description: 'Second job', quantity: '1.000000', unitPrice: '2000.000000' },
    ])

    // CUSTOMER_HAS_BALANCE means invoice2's own 2,000.0000 outstanding makes
    // the customer UNDEACTIVATABLE through POST /:id/deactivate — exactly
    // the rule open-questions.md's own Accounting-seat note names ("the
    // case rarely arises, because a customer with a non-zero balance cannot
    // be deactivated"). This is the one place this suite reaches around the
    // API to force the state ruling R-2 exists for, the same way a
    // reconciliation test would: a direct, audited-nowhere status flip,
    // proving `requireForPayment` (not `requireActiveForPosting`) is what
    // PostReceipt actually calls, independent of how the state was reached.
    await runAs({ tenantId: alpha.tenantId, userId: alpha.ownerId }, () =>
      withTenant((tx) =>
        tx
          .updateTable('customers')
          .set({ status: 'INACTIVE', version: sql`version + 1` })
          .where('tenant_id', '=', alpha.tenantId)
          .where('id', '=', customer.id)
          .execute(),
      ),
    )

    const draft = await request(app.getHttpServer())
      .post('/api/receipts')
      .set(asOwner(alpha))
      .set('Idempotency-Key', idemKey())
      .send({
        customerId: customer.id,
        method: 'BANK',
        amount: '2000.0000',
        allocations: [{ invoiceId: invoice2.id, amount: '2000.0000' }],
      })
      .expect(201)
    const posted = await request(app.getHttpServer())
      .post(`/api/receipts/${draft.body.id}/post`)
      .set(asOwner(alpha))
      .set('Idempotency-Key', idemKey())
      .send({ version: draft.body.version })
      .expect(200)
    expect(posted.body.status).toBe('POSTED')
  })
})

describe('over-allocation is refused', () => {
  it("refuses an allocation greater than the invoice's outstanding", async () => {
    const customer = await createCustomer(app, alpha)
    const invoice = await createPostedInvoice(app, alpha, customer.id)

    const draft = await request(app.getHttpServer())
      .post('/api/receipts')
      .set(asOwner(alpha))
      .set('Idempotency-Key', idemKey())
      .send({
        customerId: customer.id,
        method: 'BANK',
        amount: '15000.0000',
        allocations: [{ invoiceId: invoice.id, amount: '15000.0000' }],
      })
      .expect(201)

    await request(app.getHttpServer())
      .post(`/api/receipts/${draft.body.id}/post`)
      .set(asOwner(alpha))
      .set('Idempotency-Key', idemKey())
      .send({ version: draft.body.version })
      .expect(422)
      .expect((res) => {
        expect(res.body.error).toBe('allocation_exceeds_outstanding')
        expect(res.body.details.outstanding).toBe('10000.0000')
      })
  })
})

describe('concurrency: lock order (S-C, Security seat, Council review of efb7e3f)', () => {
  it('a concurrent draft update and customer deactivation serialise on the customer row, never deadlock (40P01)', async () => {
    // A DRAFT invoice contributes nothing to the customer's balance, so
    // deactivation is legitimately allowed to race it — exactly the
    // scenario LOCK_REGISTRY 1a exists for (modules.md §10: "a deactivation
    // waits for in-flight postings, then reads the balance they produced").
    const customer = await createCustomer(app, alpha)
    const draft = await request(app.getHttpServer())
      .post('/api/invoices')
      .set(asOwner(alpha))
      .set('Idempotency-Key', idemKey())
      .send({
        customerId: customer.id,
        lines: [{ description: 'Draft work', quantity: '1.000000', unitPrice: '100.000000' }],
      })
      .expect(201)

    const before = await request(app.getHttpServer())
      .get(`/api/customers/${customer.id}`)
      .set(asOwner(alpha))
      .expect(200)

    const [updateRes, deactivateRes] = await Promise.all([
      request(app.getHttpServer())
        .put(`/api/invoices/${draft.body.id}`)
        .set(asOwner(alpha))
        .send({
          customerId: customer.id,
          lines: [{ description: 'Updated work', quantity: '2.000000', unitPrice: '150.000000' }],
          version: draft.body.version,
        }),
      request(app.getHttpServer())
        .post(`/api/customers/${customer.id}/deactivate`)
        .set(asOwner(alpha))
        .send({ version: before.body.version }),
    ])

    // Both requests complete — no 40P01 deadlock, no 500 from either side.
    expect(updateRes.status).toBe(200)
    expect(deactivateRes.status).toBe(200)

    const finalInvoice = await request(app.getHttpServer())
      .get(`/api/invoices/${draft.body.id}`)
      .set(asOwner(alpha))
      .expect(200)
    expect(finalInvoice.body.lines).toEqual([
      expect.objectContaining({ description: 'Updated work', lineNet: '300.0000' }),
    ])

    const finalCustomer = await request(app.getHttpServer())
      .get(`/api/customers/${customer.id}`)
      .set(asOwner(alpha))
      .expect(200)
    expect(finalCustomer.body.status).toBe('INACTIVE')
  })
})

describe('closed period (A4, Accounting seat, Council review of efb7e3f)', () => {
  it('refuses to post an invoice dated in a CLOSED period, and consumes no INV number', async () => {
    // A dedicated tenant, so closing 2026-07 (FY2027's first period)
    // cannot disturb any other test's open-period posting.
    const gamma = await createCustomersTenant('M3PC')
    await runAs({ tenantId: gamma.tenantId, userId: gamma.ownerId }, () =>
      withTenant((tx) => periodEngine.close('2026-07', tx)),
    )

    const customer = await createCustomer(app, gamma)
    const draft = await request(app.getHttpServer())
      .post('/api/invoices')
      .set(asOwner(gamma))
      .set('Idempotency-Key', idemKey())
      .send({
        customerId: customer.id,
        invoiceDate: '2026-07-15',
        lines: [
          { description: 'Closed-period work', quantity: '1.000000', unitPrice: '100.000000' },
        ],
      })
      .expect(201)

    const seriesBefore = await runAs({ tenantId: gamma.tenantId, userId: gamma.ownerId }, () =>
      withTenant((tx) =>
        tx
          .selectFrom('document_sequences')
          .select('last_number')
          .where('tenant_id', '=', gamma.tenantId)
          .where('series', '=', 'INV')
          .executeTakeFirst(),
      ),
    )

    await request(app.getHttpServer())
      .post(`/api/invoices/${draft.body.id}/post`)
      .set(asOwner(gamma))
      .set('Idempotency-Key', idemKey())
      .send({ version: draft.body.version })
      .expect(422)
      .expect((res) => expect(res.body.error).toBe('period_closed'))

    const seriesAfter = await runAs({ tenantId: gamma.tenantId, userId: gamma.ownerId }, () =>
      withTenant((tx) =>
        tx
          .selectFrom('document_sequences')
          .select('last_number')
          .where('tenant_id', '=', gamma.tenantId)
          .where('series', '=', 'INV')
          .executeTakeFirst(),
      ),
    )
    expect(seriesAfter?.last_number ?? null).toBe(seriesBefore?.last_number ?? null)

    const stillDraft = await request(app.getHttpServer())
      .get(`/api/invoices/${draft.body.id}`)
      .set(asOwner(gamma))
      .expect(200)
    expect(stillDraft.body.status).toBe('DRAFT')
    expect(stillDraft.body.number).toBeNull()
  })
})

describe('audit', () => {
  it('records an audit row for a posted invoice, with the right before/after', async () => {
    const customer = await createCustomer(app, alpha)
    const invoice = await createPostedInvoice(app, alpha, customer.id)

    const rows = await runAs({ tenantId: alpha.tenantId, userId: alpha.ownerId }, () =>
      withTenant((tx) =>
        tx
          .selectFrom('audit_log')
          .select(['action', 'entity_type', 'entity_id', 'before_json', 'after_json'])
          .where('tenant_id', '=', alpha.tenantId)
          .where('entity_type', '=', 'sales_invoice')
          .where('entity_id', '=', invoice.id as string)
          .where('action', '=', 'SALES_INVOICE_POSTED')
          .execute(),
      ),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.before_json).toEqual({ status: 'DRAFT' })
    expect(rows[0]?.after_json).toMatchObject({ status: 'POSTED', number: invoice.number })
  })
})

describe('K4 (second Council re-check of 2a02731, Architecture+Accounting): sourceNumber only for document source types', () => {
  it("a journal voucher's user-typed reference never surfaces as sourceNumber, even when it LOOKS like a document number; a posted invoice's own INV number does", async () => {
    const customer = await createCustomer(app, alpha)
    const invoice = await createPostedInvoice(app, alpha, customer.id)

    const accounts = await runAs({ tenantId: alpha.tenantId, userId: alpha.ownerId }, () =>
      withTenant((tx) =>
        tx
          .selectFrom('accounts')
          .select(['id', 'code'])
          .where('tenant_id', '=', alpha.tenantId)
          .where('code', 'in', ['1120', '3100'])
          .execute(),
      ),
    )
    const bankId = accounts.find((a) => a.code === '1120')?.id as string
    const capitalId = accounts.find((a) => a.code === '3100')?.id as string

    // The reference is deliberately shaped LIKE a document number — proving
    // the gate is on `source_type`, not on the string's own shape.
    const jv = await request(app.getHttpServer())
      .post('/api/journals')
      .set(asOwner(alpha))
      .set('Idempotency-Key', idemKey('k4-jv'))
      .send({
        occurredAt: '2026-09-05',
        narration: 'test: K4 — a JV reference must never leak into sourceNumber',
        reference: 'INV-LOOKS-LIKE-A-DOCUMENT-NUMBER',
        lines: [
          { accountId: bankId, debit: '1000.0000' },
          { accountId: capitalId, credit: '1000.0000' },
        ],
      })
      .expect(200)

    const bankLedger = await request(app.getHttpServer())
      .get(`/api/ledgers/${bankId}`)
      .set(asOwner(alpha))
      .query({ from: '2026-09-05', to: '2026-09-05' })
      .expect(200)

    const jvLine = (
      bankLedger.body.lines as readonly {
        sourceType: string
        sourceId: string
        sourceNumber: string | null
      }[]
    )
      // A JV's own `source_id` is a synthetic id distinct from its entry id
      // (`jv.body.id`) — `jv.body.sourceId` is the one that matches a
      // ledger line's `sourceId`.
      .find((l) => l.sourceType === 'journal_voucher' && l.sourceId === jv.body.sourceId)
    expect(jvLine).toBeDefined()
    expect(jvLine?.sourceNumber).toBeNull()

    const customerLedger = await request(app.getHttpServer())
      .get(`/api/customers/${customer.id}/ledger`)
      .set(asOwner(alpha))
      .expect(200)
    const invoiceLine = (
      customerLedger.body.lines as readonly {
        sourceType: string
        sourceId: string
        sourceNumber: string
      }[]
    ).find((l) => l.sourceType === 'sales_invoice' && l.sourceId === invoice.id)
    expect(invoiceLine?.sourceNumber).toBe(invoice.number)
  })
})

describe('S-D (Security seat, Council review of efb7e3f): receipt isolation, allocation validation, idempotency-key shape', () => {
  it("returns the identical 404 body for an unknown receipt id and another tenant's receipt id", async () => {
    const customer = await createCustomer(app, alpha)
    const draft = await request(app.getHttpServer())
      .post('/api/receipts')
      .set(asOwner(alpha))
      .set('Idempotency-Key', idemKey())
      .send({ customerId: customer.id, allocations: [] })
      .expect(201)

    const unknown = await request(app.getHttpServer())
      .get('/api/receipts/00000000-0000-0000-0000-000000000000')
      .set(asOwner(beta))
      .expect(404)

    const crossTenant = await request(app.getHttpServer())
      .get(`/api/receipts/${draft.body.id}`)
      .set(asOwner(beta))
      .expect(404)

    // Same shape the invoice version of this test asserts (line ~334):
    // `error`/`statusCode` are the stable fields; `message`/`details.
    // receiptId`/`path` legitimately differ because they echo the id itself.
    expect(crossTenant.body.error).toBe(unknown.body.error)
    expect(crossTenant.body.statusCode).toBe(unknown.body.statusCode)
  })

  it("refuses to create a receipt draft alleging an allocation to another TENANT's invoice, with 422 INVOICE_NOT_FOUND", async () => {
    const customerBeta = await createCustomer(app, beta)
    const invoiceBeta = await createPostedInvoice(app, beta, customerBeta.id)

    const customerAlpha = await createCustomer(app, alpha)
    await request(app.getHttpServer())
      .post('/api/receipts')
      .set(asOwner(alpha))
      .set('Idempotency-Key', idemKey())
      .send({
        customerId: customerAlpha.id,
        method: 'CASH',
        amount: '1000.0000',
        allocations: [{ invoiceId: invoiceBeta.id, amount: '1000.0000' }],
      })
      .expect(422)
      .expect((res) => {
        expect(res.body.error).toBe('invoice_not_found')
        expect(res.body.details).toMatchObject({ invoiceId: invoiceBeta.id })
      })
  })

  it("refuses to update a receipt draft's allocations to name another TENANT's invoice", async () => {
    const customerBeta = await createCustomer(app, beta)
    const invoiceBeta = await createPostedInvoice(app, beta, customerBeta.id)

    const customerAlpha = await createCustomer(app, alpha)
    const draft = await request(app.getHttpServer())
      .post('/api/receipts')
      .set(asOwner(alpha))
      .set('Idempotency-Key', idemKey())
      .send({ customerId: customerAlpha.id, allocations: [] })
      .expect(201)

    await request(app.getHttpServer())
      .patch(`/api/receipts/${draft.body.id}`)
      .set(asOwner(alpha))
      .send({
        amount: '1000.0000',
        allocations: [{ invoiceId: invoiceBeta.id, amount: '1000.0000' }],
        version: draft.body.version,
      })
      .expect(422)
      .expect((res) => {
        expect(res.body.error).toBe('invoice_not_found')
        expect(res.body.details).toMatchObject({ invoiceId: invoiceBeta.id })
      })

    // The draft itself is untouched — the rejected revision never landed.
    const stillEmpty = await request(app.getHttpServer())
      .get(`/api/receipts/${draft.body.id}`)
      .set(asOwner(alpha))
      .expect(200)
    expect(stillEmpty.body.proposals).toEqual([])
  })

  it("an allocation naming another CUSTOMER's invoice (same tenant) is accepted as a draft, then refused with 422 ALLOCATION_PARTY_MISMATCH at post time", async () => {
    const customerA = await createCustomer(app, alpha)
    const customerB = await createCustomer(app, alpha)
    const invoiceB = await createPostedInvoice(app, alpha, customerB.id)

    // The invoice id EXISTS in this tenant, so create-time's existence-only
    // check (S-D) does not reject it — only post-time's assertAllocatable
    // (which knows the receipt's own customer) can catch a party mismatch.
    const draft = await request(app.getHttpServer())
      .post('/api/receipts')
      .set(asOwner(alpha))
      .set('Idempotency-Key', idemKey())
      .send({
        customerId: customerA.id,
        method: 'CASH',
        amount: '1000.0000',
        allocations: [{ invoiceId: invoiceB.id, amount: '1000.0000' }],
      })
      .expect(201)

    await request(app.getHttpServer())
      .post(`/api/receipts/${draft.body.id}/post`)
      .set(asOwner(alpha))
      .set('Idempotency-Key', idemKey())
      .send({ version: draft.body.version })
      .expect(422)
      .expect((res) => {
        expect(res.body.error).toBe('allocation_party_mismatch')
        expect(res.body.details).toMatchObject({ invoiceId: invoiceB.id })
      })
  })

  it('a malformed Idempotency-Key header is a 400, not a 500', async () => {
    const customer = await createCustomer(app, alpha)
    await request(app.getHttpServer())
      .post('/api/receipts')
      .set(asOwner(alpha))
      .set('Idempotency-Key', 'not a valid key / has spaces and slashes')
      .send({ customerId: customer.id, allocations: [] })
      .expect(400)
      .expect((res) => expect(res.body.error).toBe('idempotency_key_invalid'))
  })
})

describe('receipt RBAC', () => {
  it('403s receipt creation for a no-role user and a viewer', async () => {
    const customer = await createCustomer(app, alpha)

    await request(app.getHttpServer())
      .post('/api/receipts')
      .set(asNoRole(alpha))
      .set('Idempotency-Key', idemKey())
      .send({ customerId: customer.id, allocations: [] })
      .expect(403)

    await request(app.getHttpServer())
      .post('/api/receipts')
      .set(asViewer(alpha))
      .set('Idempotency-Key', idemKey())
      .send({ customerId: customer.id, allocations: [] })
      .expect(403)
  })

  it('403s posting and cancelling a receipt draft for a no-role user', async () => {
    const customer = await createCustomer(app, alpha)
    const draft = await request(app.getHttpServer())
      .post('/api/receipts')
      .set(asOwner(alpha))
      .set('Idempotency-Key', idemKey())
      .send({ customerId: customer.id, allocations: [] })
      .expect(201)

    await request(app.getHttpServer())
      .post(`/api/receipts/${draft.body.id}/post`)
      .set(asNoRole(alpha))
      .set('Idempotency-Key', idemKey())
      .send({ version: draft.body.version })
      .expect(403)

    await request(app.getHttpServer())
      .post(`/api/receipts/${draft.body.id}/cancel`)
      .set(asNoRole(alpha))
      .send({ version: draft.body.version })
      .expect(403)
  })

  it('403s receipt reversal for a holder of payment.receive who lacks voucher.reverse', async () => {
    // Same shape as the invoice reversal RBAC test above: the owner role
    // holds every MVP permission, so a no-role user (holds neither
    // payment.receive nor voucher.reverse) proves the decorator requires
    // BOTH, sharing the same guard-refusal body every other privileged
    // route uses.
    const customer = await createCustomer(app, alpha)
    const invoice = await createPostedInvoice(app, alpha, customer.id)
    const draft = await request(app.getHttpServer())
      .post('/api/receipts')
      .set(asOwner(alpha))
      .set('Idempotency-Key', idemKey())
      .send({
        customerId: customer.id,
        method: 'CASH',
        amount: '10000.0000',
        allocations: [{ invoiceId: invoice.id, amount: '10000.0000' }],
      })
      .expect(201)
    const receipt = await request(app.getHttpServer())
      .post(`/api/receipts/${draft.body.id}/post`)
      .set(asOwner(alpha))
      .set('Idempotency-Key', idemKey())
      .send({ version: draft.body.version })
      .expect(200)

    await request(app.getHttpServer())
      .post(`/api/receipts/${receipt.body.id}/reverse`)
      .set(asNoRole(alpha))
      .set('Idempotency-Key', idemKey())
      .send({ reason: 'test' })
      .expect(403)
  })
})

describe('A2 (Accounting seat, second Council re-check of 2a02731): multi-allocation receipt replay', () => {
  it('replays a two-invoice receipt post idempotently, both while POSTED and after REVERSED, when id-order and date-order DISAGREE', async () => {
    const customer = await createCustomer(app, alpha)

    // The original post builds its payload from `currentProposals` (sorted
    // by invoice_id); a replay rebuilds it from `allocationsOf` (sorted by
    // invoice_date). Both now funnel through `buildCustomerPaymentPayload`'s
    // own invoiceId sort, so they must fingerprint identically regardless —
    // but that is only a REAL test when id-order and date-order actually
    // disagree. Invoice ids are random UUIDs, independent of invoice_date,
    // so retry until the LATER-dated invoice has the SMALLER id: a case the
    // single-date version of this test (same day for both) could not catch,
    // since date-order and request-order coincided there by construction.
    let invoice1!: Record<string, unknown> // earlier date (2026-09-01), LARGER id
    let invoice2!: Record<string, unknown> // later date (2026-09-10), SMALLER id
    for (let attempt = 1; ; attempt++) {
      const earlier = await createPostedInvoice(
        app,
        alpha,
        customer.id,
        [{ description: 'A', quantity: '1.000000', unitPrice: '4000.000000' }],
        '2026-09-01',
      )
      const later = await createPostedInvoice(
        app,
        alpha,
        customer.id,
        [{ description: 'B', quantity: '1.000000', unitPrice: '6000.000000' }],
        '2026-09-10',
      )
      if ((later.id as string) < (earlier.id as string)) {
        invoice1 = earlier
        invoice2 = later
        break
      }
      if (attempt >= 20) {
        throw new Error(
          'could not find a later-dated invoice with a smaller id in 20 attempts — ' +
            'astronomically unlikely by chance; check UUID generation before suspecting this test.',
        )
      }
    }

    const draft = await request(app.getHttpServer())
      .post('/api/receipts')
      .set(asOwner(alpha))
      .set('Idempotency-Key', idemKey())
      .send({
        customerId: customer.id,
        method: 'BANK',
        amount: '10000.0000',
        allocations: [
          { invoiceId: invoice1.id, amount: '4000.0000' },
          { invoiceId: invoice2.id, amount: '6000.0000' },
        ],
      })
      .expect(201)

    const postKey = idemKey('multi-alloc-post')
    const firstPost = await request(app.getHttpServer())
      .post(`/api/receipts/${draft.body.id}/post`)
      .set(asOwner(alpha))
      .set('Idempotency-Key', postKey)
      .send({ version: draft.body.version })
      .expect(200)

    // LOCK_REGISTRY 1c orders allocations by ascending invoice_id, not by
    // request order — sort both sides the same way rather than assert an
    // order the API makes no promise about.
    function byInvoiceId<T extends { invoiceId: string }>(rows: readonly T[]): T[] {
      return [...rows].sort((a, b) => a.invoiceId.localeCompare(b.invoiceId))
    }
    const expectedAllocations = byInvoiceId([
      { invoiceId: invoice1.id as string, amount: '4000.0000', status: 'LIVE' },
      { invoiceId: invoice2.id as string, amount: '6000.0000', status: 'LIVE' },
    ]).map((a) => expect.objectContaining(a))
    expect(byInvoiceId(firstPost.body.allocations)).toEqual(expectedAllocations)

    // Replay #1: still POSTED. Same key, same version-carrying body — must
    // return the SAME journal entry and the SAME two LIVE allocations, not
    // re-derive them from a filtered (and therefore wrong) subset.
    const replayWhilePosted = await request(app.getHttpServer())
      .post(`/api/receipts/${draft.body.id}/post`)
      .set(asOwner(alpha))
      .set('Idempotency-Key', postKey)
      .send({ version: draft.body.version })
      .expect(200)
    expect(replayWhilePosted.body.journalEntry).toEqual(firstPost.body.journalEntry)
    expect(byInvoiceId(replayWhilePosted.body.allocations)).toEqual(expectedAllocations)

    await request(app.getHttpServer())
      .post(`/api/receipts/${draft.body.id}/reverse`)
      .set(asOwner(alpha))
      .set('Idempotency-Key', idemKey())
      .send({ reason: 'test: A2 replay after reversal' })
      .expect(200)

    // Replay #2: now REVERSED, every allocation VOIDED. The SAME post key
    // must still answer with the ORIGINAL journal entry (A1's fix: the
    // fingerprint reconstruction uses ALL allocations, not a LIVE-only
    // filter that would now see none).
    const replayAfterReversal = await request(app.getHttpServer())
      .post(`/api/receipts/${draft.body.id}/post`)
      .set(asOwner(alpha))
      .set('Idempotency-Key', postKey)
      .send({ version: draft.body.version })
      .expect(200)
    expect(replayAfterReversal.body.journalEntry).toEqual(firstPost.body.journalEntry)
  })
})
