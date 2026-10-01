import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from '@finsoft/database/testing'
import { describe, expect, it } from 'vitest'

/*
 * docs/design/M3/api-contract.md §5: "M3-Q adds one contract test per
 * route... and every 409/422 the route lists" and §3's own closing line:
 * "Every code a posting rule lists for its event appears above, either as
 * itself or as INTERNAL with the reason stated. M3-Q checks this table
 * against the rule documents' §Errors lists."
 *
 * This is that check — the static half, runnable TODAY without
 * `modules/receivables` existing, because it reads the DOCUMENTS, not the
 * code. It is not a substitute for the per-route HTTP contract tests
 * (happy path, 401, 403, cross-tenant, every 409/422), which need real
 * routes to call and are gated in receivables-adversarial.spec.ts.
 *
 * Extracts every backtick-quoted `SCREAMING_SNAKE_CASE` code from each
 * source's "Errors" section and asserts every posting-rule code is
 * accounted for by api-contract.md §3 — directly, or in one of the two
 * documented escape hatches:
 *   1. api-contract.md §3's own sentence names five kernel codes that
 *      become `INTERNAL` if they ever reach a module path ("the module
 *      never sends those, so receiving one is a bug").
 *   2. NOT_REACHABLE_VIA_THIS_API: codes that cannot occur through the
 *      DOCUMENTED request surface at all, so api-contract.md rightly does
 *      not list them — `ENTRY_NOT_FOUND` (I8/R8's request body carries no
 *      entry id; the module resolves the document's own entry internally)
 *      and `FORBIDDEN` (rule 22: no actor without a user posts, and every
 *      API request is authenticated by the time it reaches a rule). This
 *      list is deliberately narrow and reviewed here, not a general
 *      escape hatch — a new code added to it without the same reasoning
 *      recorded is the mistake this test exists to catch.
 */

const DOC = (relative: string): string => readFileSync(join(REPO_ROOT, 'docs', relative), 'utf8')

function codesInErrorsSection(source: string, heading: RegExp): readonly string[] {
  const afterHeading = source.slice(source.search(heading))
  const upToNextHeading = afterHeading.slice(afterHeading.indexOf('\n')).split(/\n## /)[0] ?? ''
  return [...upToNextHeading.matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map((m) => m[1]!)
}

const apiContract = DOC('design/M3/api-contract.md')
const serviceSale = DOC('posting-rules/service-sale.md')
const customerReceipt = DOC('posting-rules/customer-receipt.md')
const reversal = DOC('posting-rules/reversal.md')

// api-contract.md §3's Code column plus its "as INTERNAL" prose sentence.
const API_CONTRACT_CODES = new Set(codesInErrorsSection(apiContract, /## 3\. Error codes/))

const INTERNAL_BY_NAME = new Set([
  'RULE_NOT_ENABLED',
  'SALE_SETTLEMENT_NOT_ENABLED',
  'SALE_LINE_KIND_NOT_ENABLED',
  'REVERSAL_VIA_SOURCE_REQUIRED',
  'REVERSAL_OF_REVERSAL',
])

/** §Escape hatch 2 in the file header. Each entry justified there, not here. */
const NOT_REACHABLE_VIA_THIS_API = new Set(['ENTRY_NOT_FOUND', 'FORBIDDEN'])

/** The kernel's shape-validation code; the API's own zod schema stands in front of it at every route (VALIDATION_FAILED, §1). */
const KERNEL_ONLY_SHAPE_CODES = new Set(['PAYLOAD_INVALID'])

function assertEveryRuleCodeIsAccountedFor(label: string, codes: readonly string[]): void {
  const unaccounted = codes.filter(
    (code) =>
      !API_CONTRACT_CODES.has(code) &&
      !INTERNAL_BY_NAME.has(code) &&
      !NOT_REACHABLE_VIA_THIS_API.has(code) &&
      !KERNEL_ONLY_SHAPE_CODES.has(code),
  )
  expect(
    unaccounted,
    `${label}: code(s) not in api-contract.md §3, not one of the five named ` +
      "INTERNAL codes, and not in this test's NOT_REACHABLE_VIA_THIS_API list. " +
      "Either api-contract.md §3 is missing a row, or this test's allowlist needs " +
      'a reviewed, justified addition — never a silent one.',
  ).toEqual([])
}

describe('api-contract.md §3 accounts for every posting-rule error code (M3-Q, static)', () => {
  it('every service-sale.md §12 code is accounted for', () => {
    const codes = codesInErrorsSection(serviceSale, /## 12\. Errors/)
    expect(codes.length, 'the extraction itself must not be vacuous').toBeGreaterThan(5)
    assertEveryRuleCodeIsAccountedFor('service-sale.md §12', codes)
  })

  it('every customer-receipt.md §11 code is accounted for', () => {
    const codes = codesInErrorsSection(customerReceipt, /## 11\. Errors/)
    expect(codes.length).toBeGreaterThan(5)
    assertEveryRuleCodeIsAccountedFor('customer-receipt.md §11', codes)
  })

  it('every reversal.md §11 code is accounted for', () => {
    const codes = codesInErrorsSection(reversal, /## 11\. Errors/)
    expect(codes.length).toBeGreaterThan(5)
    assertEveryRuleCodeIsAccountedFor('reversal.md §11', codes)
  })

  it('the two escape hatches are not vacuous either — this test could pass by extracting nothing', () => {
    expect(API_CONTRACT_CODES.size).toBeGreaterThan(20)
    expect(INTERNAL_BY_NAME.size).toBe(5)
  })
})
