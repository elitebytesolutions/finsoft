import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { newIdempotencyKey, useIdempotencyKey } from '@/lib/api/idempotency-key'

/*
 * journal-voucher.md §7 / reversal.md §7: "Required key... three identical
 * submissions produce one voucher and one number." This is the client half
 * of that contract — one key per form instance, stable across re-renders,
 * reused on retry, replaced only when the caller explicitly starts over.
 */

describe('newIdempotencyKey', () => {
  it('returns a v4-shaped UUID', () => {
    const key = newIdempotencyKey()
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  })

  it('never returns the same key twice', () => {
    const a = newIdempotencyKey()
    const b = newIdempotencyKey()
    expect(a).not.toBe(b)
  })
})

describe('useIdempotencyKey', () => {
  it('mints a key on first render', () => {
    const { result } = renderHook(() => useIdempotencyKey())
    expect(result.current.key).toMatch(/^[0-9a-f-]{36}$/i)
  })

  it('keeps the same key across re-renders — a retry of the same submission reuses it', () => {
    const { result, rerender } = renderHook(() => useIdempotencyKey())
    const first = result.current.key
    rerender()
    rerender()
    expect(result.current.key).toBe(first)
  })

  it('mints a fresh key only when reset() is called — a genuinely new submission', () => {
    const { result, rerender } = renderHook(() => useIdempotencyKey())
    const first = result.current.key
    const returned = result.current.reset()
    expect(returned).not.toBe(first)
    rerender()
    expect(result.current.key).toBe(returned)
  })
})
