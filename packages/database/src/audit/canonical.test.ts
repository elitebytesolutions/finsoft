import { describe, expect, it } from 'vitest'
import {
  AuditCanonicalizationError,
  assertJcsSafe,
  computeAuditHash,
  GENESIS_HASH,
  jcsSerialize,
  type CanonicalAuditRecord,
} from './canonical.ts'

/*
 * ADR-0020's normative examples, reproduced exactly. "An independent party,
 * given only this document and the table contents, must be able to recompute
 * every hash and get the same bytes" — this file is that independent party.
 */

describe('golden vector — example 1, genesis', () => {
  const record: CanonicalAuditRecord = {
    action: 'SESSION_CREATED',
    actor_user_id: '6f1e9e1a-0d3e-4a5b-8c7d-2e4f6a8b0c1d',
    after_json: { mfa: 'false' },
    before_json: null,
    entity_id: '9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d',
    entity_type: 'session',
    id: '11111111-2222-4333-8444-555555555555',
    ip: '203.0.113.7',
    occurred_at: '2026-09-24T00:16:59.383214Z',
    request_id: 'd87bba6f-e498-495e-acc5-1fb75e5fc075',
    seq: '1',
    tenant_id: '00000000-0000-4000-8000-000000000001',
  }

  it('produces the JCS length ADR-0020 states (426 bytes)', () => {
    const jcs = jcsSerialize(record as never)
    expect(Buffer.byteLength(jcs, 'utf8')).toBe(426)
  })

  it('reproduces the genesis hash exactly', () => {
    const { hash, jcs } = computeAuditHash(GENESIS_HASH, record)
    // framed input = 64 (previous_hash) + 1 (0x1F) + 2 ("v1") + 1 (0x1F) + 426 (jcs) = 494
    expect(64 + 1 + 2 + 1 + Buffer.byteLength(jcs, 'utf8')).toBe(494)
    expect(hash).toBe('38e6aa16f94d209ecdf1c21a813d47918982fbd843e19ff01f507d4de4db0d11')
  })

  it('reproduces the same hash with input keys shuffled — order must not matter', () => {
    // Round 3 review regenerated the vector with keys deliberately shuffled.
    // jcsSerialize sorts keys itself, so an object literal's own key order
    // (which this test deliberately scrambles relative to the block above)
    // must make no difference at all.
    const shuffled: CanonicalAuditRecord = {
      tenant_id: record.tenant_id,
      seq: record.seq,
      request_id: record.request_id,
      ip: record.ip,
      entity_type: record.entity_type,
      entity_id: record.entity_id,
      before_json: record.before_json,
      after_json: record.after_json,
      action: record.action,
      actor_user_id: record.actor_user_id,
      id: record.id,
      occurred_at: record.occurred_at,
    }
    expect(computeAuditHash(GENESIS_HASH, shuffled).hash).toBe(
      '38e6aa16f94d209ecdf1c21a813d47918982fbd843e19ff01f507d4de4db0d11',
    )
  })

  it('produces a DIFFERENT hash if hash_version were (wrongly) included among the twelve columns', () => {
    // ADR-0020 §4: "The record is these twelve columns, and no others."
    // Including hash_version was the first version's contradiction and
    // produces a documented, different, WRONG hash. Proves this
    // implementation's column list is exactly the twelve, not thirteen.
    const withVersion = { ...record, hash_version: 'v1' } as unknown as CanonicalAuditRecord
    const { hash } = computeAuditHash(GENESIS_HASH, withVersion)
    expect(hash).not.toBe('38e6aa16f94d209ecdf1c21a813d47918982fbd843e19ff01f507d4de4db0d11')
    expect(hash).toBe('50855dd5e5a65cea4279373a6af26962d73f404f6cf955901a9d5cab2b0fa82a')
  })
})

describe('golden vector — example 2, the trailing zero, in full', () => {
  const example1Hash = '38e6aa16f94d209ecdf1c21a813d47918982fbd843e19ff01f507d4de4db0d11'

  const record: CanonicalAuditRecord = {
    action: 'PRICE_OVERRIDDEN',
    actor_user_id: '6f1e9e1a-0d3e-4a5b-8c7d-2e4f6a8b0c1d',
    after_json: { amount: '1.1100' },
    before_json: { amount: '1.1000' },
    entity_id: '9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d',
    entity_type: 'price',
    id: '22222222-3333-4444-8555-666666666666',
    ip: '203.0.113.7',
    occurred_at: '2026-09-24T00:17:04.120000Z',
    request_id: 'd87bba6f-e498-495e-acc5-1fb75e5fc075',
    seq: '2',
    tenant_id: '00000000-0000-4000-8000-000000000001',
  }

  it('chains onto example 1 and reproduces the exact hash', () => {
    const jcs = jcsSerialize(record as never)
    expect(Buffer.byteLength(jcs, 'utf8')).toBe(444)

    const { hash } = computeAuditHash(example1Hash, record)
    expect(hash).toBe('bc41ce062e558a0ebe4bd967937aa9db9bed5241e7df9c26bc7357db20546343')
  })

  it('"1.1000" and "1.1100" hash differently from what JSON.stringify would have produced', () => {
    // JSON.stringify(1.10) === '1.1' — the exact defect ADR-0020 §2 measures.
    // A tampered 1.1000 -> 1.1 must change the hash, which requires the
    // strings to be treated as strings throughout, never re-parsed as numbers.
    expect(JSON.stringify(1.1)).toBe('1.1')
    const tampered = { ...record, before_json: { amount: '1.1' } }
    expect(computeAuditHash(example1Hash, tampered).hash).not.toBe(
      'bc41ce062e558a0ebe4bd967937aa9db9bed5241e7df9c26bc7357db20546343',
    )
  })
})

describe('jcsSerialize', () => {
  it('sorts object keys by UTF-16 code unit, not insertion order', () => {
    expect(jcsSerialize({ bb: 'x', aa: 'y', b: 'z', a: 'w' })).toBe(
      '{"a":"w","aa":"y","b":"z","bb":"x"}',
    )
  })

  it('sorts length-varying keys the way RFC 8785 requires, not the way jsonb does', () => {
    // ADR-0020's own measured counter-example: jsonb orders by length first
    // ("a","b","aa","bb"), JCS by code unit ("a","aa","b","bb").
    expect(jcsSerialize({ bb: '1', aa: '2', b: '3', a: '4' })).toBe(
      '{"a":"4","aa":"2","b":"3","bb":"1"}',
    )
  })

  it('preserves array order', () => {
    expect(jcsSerialize(['z', 'a', 'm'])).toBe('["z","a","m"]')
  })

  it('renders an explicit null distinctly from an omitted key', () => {
    expect(jcsSerialize({ a: null })).toBe('{"a":null}')
    expect(jcsSerialize({})).toBe('{}')
  })

  it('escapes strings exactly as JSON.stringify does, which matches JCS for the string subset', () => {
    expect(jcsSerialize('a"b\\c\nd')).toBe(JSON.stringify('a"b\\c\nd'))
  })

  it('rejects a number', () => {
    expect(() => jcsSerialize(3 as never)).toThrow(AuditCanonicalizationError)
  })

  it('rejects a boolean', () => {
    expect(() => jcsSerialize(true as never)).toThrow(AuditCanonicalizationError)
  })
})

describe('assertJcsSafe', () => {
  it('accepts strings, null, arrays and nested objects', () => {
    expect(() => assertJcsSafe({ a: 'x', b: null, c: ['y', { d: 'z' }] })).not.toThrow()
  })

  it('rejects a number nested inside an object, naming the path', () => {
    expect(() => assertJcsSafe({ amount: 1.1 as never })).toThrow(/\$\.amount/)
  })

  it('rejects a boolean nested inside an array', () => {
    expect(() => assertJcsSafe(['ok', true as never])).toThrow(/\$\[1\]/)
  })
})
