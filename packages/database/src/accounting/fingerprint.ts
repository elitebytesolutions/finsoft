import { createHash } from 'node:crypto'

/*
 * The idempotency fingerprint. docs/posting-rules/README.md §4: "Canonical
 * form of (event, referenceType, referenceId, occurredAt, actor user id,
 * payload)." Same key + same fingerprint -> the original result. Same key +
 * a DIFFERENT fingerprint -> IDEMPOTENCY_KEY_REUSED.
 *
 * A minimal canonical-JSON stringify (sorted object keys, no whitespace) —
 * deliberately NOT `packages/database`'s audit `jcsSerialize`. That function
 * additionally enforces ADR-0020's audit-chain-specific "no JSON numbers or
 * booleans" rule, which is a hashing-integrity concern for the audit trail,
 * not a property this fingerprint's own job (request identity) needs to
 * inherit or be coupled to.
 */

function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`
  }
  throw new Error(`computeRequestFingerprint: cannot canonicalize a value of type ${typeof value}.`)
}

export interface FingerprintInput {
  readonly event: string
  readonly referenceType: string
  readonly referenceId: string
  readonly occurredAt: string
  readonly actorUserId: string
  readonly payload: unknown
}

/** sha256 hex (64 chars) of the canonical request tuple. */
export function computeRequestFingerprint(input: FingerprintInput): string {
  const canonical = canonicalize({
    event: input.event,
    referenceType: input.referenceType,
    referenceId: input.referenceId,
    occurredAt: input.occurredAt,
    actorUserId: input.actorUserId,
    payload: input.payload,
  })
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}
