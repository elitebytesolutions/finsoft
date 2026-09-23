import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import App, { MemoryRouter } from './harness'

afterEach(cleanup)

/* NOT ported from ui-prototype/src/*.test.tsx — this is new, added because
 * the port introduced a real behavioural difference the ported suite never
 * exercises.
 *
 * apps/web/src/mocks/store.ts seeds `usePersistentData()`'s state with the
 * hard-coded defaults and only reads localStorage inside a useEffect, to
 * stay SSR-safe (the prototype's ui-prototype/src/store.ts read localStorage
 * synchronously in the useState initialiser, which throws during Next's
 * prerender). Every ported test calls `localStorage.clear()` before
 * rendering, so `restore(null)` always returns the untouched seed object by
 * reference and the hydration effect's setData(...) is a same-reference
 * no-op — the effect never actually observably runs in the ported suite.
 * That leaves the one thing that changed about this data path completely
 * uncovered, so it gets a dedicated test instead. */
describe('mocks/store.ts SSR-safe localStorage hydration', () => {
  it('reflects data restored from localStorage after mount, not just the hard-coded seed', () => {
    localStorage.clear()
    localStorage.setItem(
      'finsoft-data-v7',
      JSON.stringify({
        products: [{ name: 'Hydration Canary 500mg', batches: [] }],
        sales: [],
        purchases: [
          {
            id: 'PUR-CANARY-0001',
            date: '01 Jan 2026',
            supplier: 'Canary Supplier Co',
            product: 'Hydration Canary 500mg',
            qty: 1,
            amount: 100,
            status: 'Posted',
            batch: 'CANARY-B1',
            expiry: '2030-01-01',
            unitCost: 100,
          },
        ],
      }),
    )

    render(
      <MemoryRouter initialEntries={['/purchasing']}>
        <App />
      </MemoryRouter>,
    )

    // Present only if the post-mount restore(localStorage.getItem(...))
    // effect ran and its setData(...) update actually reached the render —
    // the hard-coded seed in mocks/data.ts has neither this id nor supplier.
    expect(screen.getByText('PUR-CANARY-0001')).toBeInTheDocument()
    expect(screen.getByText('Canary Supplier Co')).toBeInTheDocument()
  })

  it("falls back to the seed when localStorage holds nothing (the ported suite's implicit path)", () => {
    localStorage.clear()
    render(
      <MemoryRouter initialEntries={['/purchasing']}>
        <App />
      </MemoryRouter>,
    )
    expect(screen.queryByText('PUR-CANARY-0001')).not.toBeInTheDocument()
    expect(screen.getByText('Getz Pharma')).toBeInTheDocument()
  })
})
