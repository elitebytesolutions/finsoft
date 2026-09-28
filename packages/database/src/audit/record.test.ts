import { describe, expect, it } from 'vitest'
import { buildCanonicalRecord, toMicrosecondIso } from './record.ts'

describe('toMicrosecondIso', () => {
  it('pads a millisecond-precision Date to six fractional digits, matching ADR-0020 example 2', () => {
    expect(toMicrosecondIso(new Date('2026-09-24T00:17:04.120Z'))).toBe(
      '2026-09-24T00:17:04.120000Z',
    )
  })

  it('pads a Date with zero milliseconds', () => {
    expect(toMicrosecondIso(new Date('2026-09-24T00:00:00.000Z'))).toBe(
      '2026-09-24T00:00:00.000000Z',
    )
  })

  it('rejects an invalid Date rather than producing "Invalid Date" text', () => {
    expect(() => toMicrosecondIso(new Date('not-a-date'))).toThrow(RangeError)
  })
})

describe('buildCanonicalRecord', () => {
  it('lowercases uuid fields but leaves action/entity_type/seq/timestamps alone', () => {
    const record = buildCanonicalRecord({
      id: 'AAAAAAAA-2222-4333-8444-555555555555',
      tenantId: '00000000-0000-4000-8000-000000000001',
      seq: '1',
      occurredAt: new Date('2026-09-24T00:16:59.383Z'),
      actorUserId: '6F1E9E1A-0D3E-4A5B-8C7D-2E4F6A8B0C1D',
      action: 'SESSION_CREATED',
      entityType: 'session',
      entityId: null,
      beforeJson: null,
      afterJson: { mfa: 'false' },
      ip: '203.0.113.7',
      requestId: null,
    })

    expect(record.id).toBe('aaaaaaaa-2222-4333-8444-555555555555')
    expect(record.actor_user_id).toBe('6f1e9e1a-0d3e-4a5b-8c7d-2e4f6a8b0c1d')
    expect(record.entity_id).toBeNull()
    expect(record.occurred_at).toBe('2026-09-24T00:16:59.383000Z')
    expect(record.action).toBe('SESSION_CREATED')
    expect(record.seq).toBe('1')
  })
})
