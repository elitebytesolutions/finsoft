import { ESLint } from 'eslint'
import { beforeAll, describe, expect, it } from 'vitest'
import { REPO_ROOT } from '@finsoft/database/testing'

/*
 * Council T3 kernel-only fences (Arch 1/2/5, Acct F3/R3), exercised.
 *
 *   1. fiscal_periods transitions are written only by
 *      packages/accounting-kernel/src/queries/periods.ts.
 *   2. assignDocumentNumber, assignTenantDocumentNumber and
 *      lockEntryForReversal are called only by packages/accounting-kernel
 *      (and the database test suites).
 *
 * Same method as lint-boundaries.spec.ts: lint a string AS IF it lived at a
 * path, and assert the specific message fires. A lint rule that has never
 * been observed to fire is a comment.
 */

let eslint: ESLint

beforeAll(() => {
  eslint = new ESLint({ cwd: REPO_ROOT })
})

async function messagesFor(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath })
  return (result?.messages ?? []).map((m) => m.message)
}

const PERIOD = 'fiscal_periods transitions (close, reopen, lock) are written only by'
const KERNEL_ONLY = 'are called only by packages/accounting-kernel'

const hits = (messages: string[], fragment: string) =>
  messages.filter((m) => m.includes(fragment)).length

describe('fiscal_periods transitions: kernel queries only (Council T3)', () => {
  const violations: ReadonlyArray<readonly [string, string, string]> = [
    [
      'packages/database: builder updateTable',
      'packages/database/src/accounting/period-admin.ts',
      `export const w = (tx: any) => tx.updateTable('fiscal_periods').set({ status: 'OPEN' }).execute()`,
    ],
    [
      'packages/database: sql`` tag',
      'packages/database/src/accounting/period-admin.ts',
      "import { sql } from 'kysely'\nexport const q = (tx: any) => sql`UPDATE fiscal_periods SET status = 'OPEN'`.execute(tx)",
    ],
    [
      'packages/database: raw string literal',
      'packages/database/src/accounting/period-admin.ts',
      `export const q = 'update public.fiscal_periods set status = $1 where id = $2'`,
    ],
    [
      'packages/database: accounting/periods.ts — the former TRANSITIONAL exemption is gone',
      'packages/database/src/accounting/periods.ts',
      `export const w = (tx: any) => tx.updateTable('fiscal_periods').set({ status: 'CLOSED' }).execute()`,
    ],
    [
      'packages/database: provisioning.ts is not a licence to transition',
      'packages/database/src/provisioning.ts',
      `export const w = (tx: any) => tx.updateTable('fiscal_periods').set({}).execute()`,
    ],
    [
      'modules/*/infrastructure: builder updateTable',
      'modules/sales/infrastructure/period-repo.ts',
      `export const w = (tx: any) => tx.updateTable('fiscal_periods').set({}).execute()`,
    ],
    [
      'modules/*/infrastructure: untagged template',
      'modules/sales/infrastructure/period-repo.ts',
      'export const q = `UPDATE fiscal_periods SET status = $1`',
    ],
    [
      'modules/*/infrastructure: deleteFrom',
      'modules/sales/infrastructure/period-repo.ts',
      `export const w = (tx: any) => tx.deleteFrom('fiscal_periods').execute()`,
    ],
    [
      'tools script: raw string',
      'tools/seed/reopen.mjs',
      `export const q = 'UPDATE fiscal_periods SET status = $1'`,
    ],
  ]

  it.each(violations)('fires — %s', async (_label, path, code) => {
    expect(hits(await messagesFor(path, code), PERIOD)).toBeGreaterThanOrEqual(1)
  })

  it('leaves packages/accounting-kernel/src/queries/periods.ts alone — the one writer', async () => {
    const messages = await messagesFor(
      'packages/accounting-kernel/src/queries/periods.ts',
      "import { sql } from 'kysely'\nexport const q = (tx: any) => sql`UPDATE fiscal_periods SET status = 'CLOSED'`.execute(tx)",
    )
    expect(hits(messages, PERIOD)).toBe(0)
  })

  it('does not fire on a read, on createFiscalYear’s INSERT, or on prose naming the table', async () => {
    const messages = await messagesFor(
      'packages/database/src/provisioning.ts',
      `export const r = (tx: any) => tx.selectFrom('fiscal_periods').select('id').execute()
       export const i = (tx: any) => tx.insertInto('fiscal_periods').values({}).execute()
       export const note = 'a period is born OPEN in fiscal_periods'`,
    )
    expect(hits(messages, PERIOD)).toBe(0)
  })
})

describe('numbering and the reversal lock: kernel callers only (Council T3)', () => {
  const violations: ReadonlyArray<readonly [string, string, string]> = [
    [
      'module infrastructure: named import',
      'modules/sales/infrastructure/invoice-repo.ts',
      `import { assignDocumentNumber } from '@finsoft/database'\nexport const f = assignDocumentNumber`,
    ],
    [
      'module infrastructure: renamed import',
      'modules/sales/infrastructure/customer-repo.ts',
      `import { assignTenantDocumentNumber as nextCode } from '@finsoft/database'\nexport const f = nextCode`,
    ],
    [
      'module infrastructure: namespace member access',
      'modules/sales/infrastructure/invoice-repo.ts',
      `import * as db from '@finsoft/database'\nexport const f = (tx: any) => db.lockEntryForReversal(tx, 't', 'e')`,
    ],
    [
      'module infrastructure: destructured dynamic import',
      'modules/sales/infrastructure/invoice-repo.ts',
      `export async function f() { const { lockEntryForReversal } = await import('@finsoft/database'); return lockEntryForReversal }`,
    ],
    [
      'module: re-export laundering the name',
      'modules/sales/infrastructure/index.ts',
      `export { assignDocumentNumber as n } from '@finsoft/database'`,
    ],
    [
      'apps/api',
      'apps/api/src/journal/numbers.ts',
      `import { assignDocumentNumber } from '@finsoft/database'\nexport const f = assignDocumentNumber`,
    ],
    [
      'packages/reporting (another package)',
      'packages/reporting/src/numbers.ts',
      `import { assignDocumentNumber } from '@finsoft/database'\nexport const f = assignDocumentNumber`,
    ],
    [
      'packages/database itself, outside the definitions',
      'packages/database/src/accounting/ledger.ts',
      `import { assignDocumentNumber } from './sequences.ts'\nexport const f = assignDocumentNumber`,
    ],
  ]

  it.each(violations)('fires — %s', async (_label, path, code) => {
    expect(hits(await messagesFor(path, code), KERNEL_ONLY)).toBeGreaterThanOrEqual(1)
  })

  it('leaves the kernel alone — business logic and queries', async () => {
    for (const path of [
      'packages/accounting-kernel/src/posting-engine.ts',
      'packages/accounting-kernel/src/reversal.ts',
      'packages/accounting-kernel/src/queries/journal-writes.ts',
    ]) {
      const messages = await messagesFor(
        path,
        `import { assignDocumentNumber, lockEntryForReversal } from '@finsoft/database'\nexport const f = [assignDocumentNumber, lockEntryForReversal]`,
      )
      expect(hits(messages, KERNEL_ONLY), path).toBe(0)
    }
  })

  it('leaves the definitions and the package index’s own re-export alone', async () => {
    expect(
      hits(
        await messagesFor(
          'packages/database/src/index.ts',
          `export { assignDocumentNumber, assignTenantDocumentNumber } from './accounting/sequences.ts'\nexport { lockEntryForReversal } from './accounting/journal.ts'`,
        ),
        KERNEL_ONLY,
      ),
    ).toBe(0)
    expect(
      hits(
        await messagesFor(
          'packages/database/src/accounting/sequences.ts',
          `export async function assignDocumentNumber() { return '' }`,
        ),
        KERNEL_ONLY,
      ),
    ).toBe(0)
  })

  it('leaves the database test suite alone — it proves the counter directly', async () => {
    const messages = await messagesFor(
      'database/tests/document-sequences.spec.ts',
      `import { assignDocumentNumber } from '@finsoft/database'\nexport const f = assignDocumentNumber`,
    )
    expect(hits(messages, KERNEL_ONLY)).toBe(0)
  })
})
