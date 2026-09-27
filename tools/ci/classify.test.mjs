import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classify, classifyTier, computeFull, loadConfig } from './classify.mjs'

const config = loadConfig()

function run(files, opts = {}) {
  return classify({
    files,
    config,
    cliFull: opts.full ?? false,
    eventName: opts.eventName,
    ref: opts.ref,
  })
}

test('docs-only change classifies as T0', () => {
  const r = run(['docs/adr/0001-something.md'])
  assert.equal(r.tier, 'T0')
  assert.equal(r.runDbSuites, false)
  assert.equal(r.runFinancial, false)
  assert.equal(r.runE2e, false)
})

test('NON_NEGOTIABLES.md §3 (LEVEL 0): the FinancialInvariantSuite runs on every tier, including a docs-only T0 PR — a risk tier cannot waive it', () => {
  const r = run(['docs/adr/0001-something.md'])
  assert.equal(r.tier, 'T0')
  assert.equal(r.runInvariants, true)
  assert.ok(r.suites.includes('invariants'))
})

test('the FinancialInvariantSuite also runs at T1, T2 and T3 — it is not part of the tiering', () => {
  for (const files of [
    ['apps/web/src/app/invoices/page.tsx'], // T1
    ['database/migrations/006-x.sql'], // T2
    ['packages/accounting-kernel/src/posting.ts'], // T3
  ]) {
    const r = run(files)
    assert.equal(r.runInvariants, true, `expected runInvariants for ${files.join(',')}`)
    assert.ok(
      r.suites.includes('invariants'),
      `expected 'invariants' in suites for ${files.join(',')}`,
    )
  }
})

test('a plain markdown file at the repo root is T0', () => {
  const r = run(['README.md'])
  assert.equal(r.tier, 'T0')
})

test("a markdown file inside a T1+ directory takes that directory's tier — highest tier wins", () => {
  const r = run(['packages/ui/README.md'])
  assert.equal(r.tier, 'T1')
})

test('apps/web screen change classifies as T1 and triggers e2e + web-preview', () => {
  const r = run(['apps/web/src/app/invoices/page.tsx'])
  assert.equal(r.tier, 'T1')
  assert.equal(r.webChanged, true)
  assert.equal(r.runE2e, true)
  assert.equal(r.runWebPreview, true)
  assert.equal(r.runDbSuites, false)
  assert.equal(r.runFinancial, false)
})

test('a database/migrations file classifies as T2 and requires db-suites + codeql, not financial', () => {
  const r = run(['database/migrations/006-something.sql'])
  assert.equal(r.tier, 'T2')
  assert.equal(r.runDbSuites, true)
  assert.equal(r.runCodeql, true)
  assert.equal(r.runFinancial, false)
})

test('a packages/accounting-kernel change classifies as T3 and requires the financial gate', () => {
  const r = run(['packages/accounting-kernel/src/posting.ts'])
  assert.equal(r.tier, 'T3')
  assert.equal(r.runFinancial, true)
  assert.equal(r.runDbSuites, true) // T3 implies T2's db-suites too
  assert.equal(r.runCodeql, true)
})

test('an unknown path fails safe UP to T1, never down to T0', () => {
  const r = run(['some/brand-new/top-level-thing.xyz'])
  assert.equal(r.tier, 'T1')
  assert.ok(r.reasons.some((s) => s.includes('unmatched paths default to T1')))
})

test('mixed changes take the highest matching tier', () => {
  const r = run([
    'docs/README.md',
    'packages/accounting-kernel/src/posting.ts',
    'apps/web/src/x.tsx',
  ])
  assert.equal(r.tier, 'T3')
  assert.equal(r.runFinancial, true)
  // Only apps/web/src/x.tsx maps to an image; the kernel and the doc do not.
  assert.deepEqual(r.images.slice().sort(), ['web'])
})

test('image mapping: apps/api/src change maps to the api image', () => {
  const r = run(['apps/api/src/health/health.service.ts'])
  assert.deepEqual(r.images, ['api'])
})

test('image mapping: apps/worker change maps to the worker image', () => {
  const r = run(['apps/worker/src/main.ts'])
  assert.deepEqual(r.images, ['worker'])
})

test('image mapping: apps/web change maps to the web image', () => {
  const r = run(['apps/web/src/app/page.tsx'])
  assert.deepEqual(r.images, ['web'])
})

test('image mapping: a shared package used by more than one app maps to every consumer', () => {
  const r = run(['packages/database/src/index.ts'])
  assert.deepEqual(r.images.sort(), ['api', 'worker'].sort())
})

test('image mapping: root package-lock.json touches all three images', () => {
  const r = run(['package-lock.json'])
  assert.deepEqual(r.images.sort(), ['api', 'web', 'worker'].sort())
})

test('T2 tier without an app-code change does not trigger e2e', () => {
  const r = run(['packages/database/src/index.ts'])
  assert.equal(r.tier, 'T2')
  assert.equal(r.webChanged, false)
  assert.equal(r.apiChanged, false)
  assert.equal(r.workerChanged, false)
  assert.equal(r.runE2e, false)
})

test('T2 tier WITH an app-code change (e.g. a guard file) does trigger e2e', () => {
  const r = run(['apps/api/src/common/tenant.guard.ts'])
  assert.equal(r.tier, 'T2')
  assert.equal(r.apiChanged, true)
  assert.equal(r.runE2e, true)
})

test('full=true runs everything regardless of tier', () => {
  const r = run(['docs/README.md'], { full: true })
  assert.equal(r.tier, 'T0')
  assert.equal(r.full, true)
  assert.equal(r.runDbSuites, true)
  assert.equal(r.runFinancial, true)
  assert.equal(r.runE2e, true)
  assert.equal(r.runCodeql, true)
  assert.equal(r.runWebPreview, false) // full builds+pushes properly, not a "preview" artifact
})

test('no changed files classifies as T0 with nothing extra to run', () => {
  const r = run([])
  assert.equal(r.tier, 'T0')
  assert.equal(r.runDbSuites, false)
})

test('classifyTier: unmatched path is labelled as fail-safe, not silently absorbed', () => {
  const { tier, perFile } = classifyTier(['weird/path.bin'], config)
  assert.equal(tier, 'T1')
  assert.equal(perFile[0].label, 'unmatched path — fail-safe default')
})

test('computeFull: schedule event is always full', () => {
  assert.equal(computeFull({ eventName: 'schedule', config }).full, true)
})

test('computeFull: workflow_dispatch is always full', () => {
  assert.equal(computeFull({ eventName: 'workflow_dispatch', config }).full, true)
})

test('computeFull: a push to refs/heads/develop is full', () => {
  assert.equal(computeFull({ ref: 'refs/heads/develop', config }).full, true)
})

test('computeFull: a push to refs/heads/release/1.2 is full', () => {
  assert.equal(computeFull({ ref: 'refs/heads/release/1.2', config }).full, true)
})

test('computeFull: an ordinary feature branch is not full', () => {
  assert.equal(computeFull({ ref: 'refs/heads/feature/OPS-002-x', config }).full, false)
})

test('computeFull: explicit --full / --no-full override detection', () => {
  assert.equal(computeFull({ cliFull: true, ref: 'refs/heads/feature/x', config }).full, true)
  assert.equal(computeFull({ cliFull: false, eventName: 'schedule', config }).full, false)
})
