import { createHash } from 'node:crypto'

/*
 * RFC 8785 (JCS) canonicalisation and the ADR-0020 §4 hash framing.
 *
 * This file is deliberately independent of the database and of Kysely: it is
 * pure functions over already-extracted values, so it can be exercised with
 * the ADR's own golden vectors in canonical.test.ts and reproduced by anyone
 * with the ADR and nothing else, which is the property ADR-0020 exists to
 * give.
 *
 * ── The one restriction beyond JCS ────────────────────────────────────────
 *
 * ADR-0020 §2: "no JSON numbers and no JSON booleans. Every leaf is a string
 * or null." This is not a style rule (§2 reason 3): JCS serialises numbers as
 * ECMAScript does, which is lossy (`1.10` -> `1.1`), and the hash is computed
 * by the application before insert and recomputed by the verifier after
 * reading the value back through jsonb — so a number admitted at either end
 * makes that round trip unable to agree with itself forever. `jcsSerialize`
 * below enforces this by construction: a number or boolean does not match any
 * branch and falls through to the final throw.
 */

/** A value legal inside a canonical audit record. No numbers, no booleans. */
export type JsonValue = string | null | JsonValue[] | JsonObject

/** An object whose values are each a JsonValue. What before_json/after_json must be at the top level. */
export interface JsonObject {
  readonly [key: string]: JsonValue
}

export class AuditCanonicalizationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuditCanonicalizationError'
  }
}

/**
 * Recursively reject a number or boolean anywhere in `value`, including
 * inside before_json/after_json supplied by a caller.
 *
 * Called before hashing so a module that passed an unconverted amount gets a
 * clear TypeScript-level error naming the path, rather than a bare
 * `audit_log_before_json_no_numbers` CHECK violation five layers down in a
 * posting transaction that then has to roll back.
 */
export function assertJcsSafe(value: JsonValue, path = '$'): void {
  if (value === null || typeof value === 'string') return

  if (Array.isArray(value)) {
    value.forEach((element, index) => assertJcsSafe(element, `${path}[${index}]`))
    return
  }

  if (typeof value === 'object') {
    for (const [key, element] of Object.entries(value)) {
      assertJcsSafe(element, `${path}.${key}`)
    }
    return
  }

  throw new AuditCanonicalizationError(
    `${path}: a ${typeof value} (${JSON.stringify(value)}) is not permitted in an audit record. ` +
      'ADR-0020 §2: every leaf must be a string or null — convert money and quantities to their ' +
      'fixed-scale string form and booleans to "true"/"false" before calling recordAudit.',
  )
}

/**
 * JCS-serialise a value already restricted to string/null/array/object.
 *
 * Two properties this relies on rather than re-implements:
 *
 *   - Key ordering: `Object.keys(...).sort()` with no comparator performs a
 *     lexicographic comparison over UTF-16 code units, which is exactly what
 *     RFC 8785 §3.2.3 requires ("sorted ... by comparing their UTF-16 code
 *     unit sequences"). This is not a coincidence; ECMAScript compatibility
 *     was a design goal of the RFC.
 *   - String escaping: `JSON.stringify` on a plain string produces exactly
 *     RFC 8785 §3.2.2.2's required form (mandatory \", \\, and \u00XX-style
 *     escapes for control characters below U+0020; every other code point,
 *     including non-ASCII, emitted raw). The hazard §2 documents —
 *     `JSON.stringify(1.10) -> 1.1` — is a NUMBER-formatting defect; string
 *     escaping was never the problem, which is why a number or boolean is
 *     rejected before it can reach this function rather than patched inside
 *     it.
 *
 * A number or boolean does not match any branch below and falls through to
 * the final throw — the same guarantee `assertJcsSafe` gives, enforced again
 * here so this function is safe to call directly in a test without going
 * through the caller-facing assertion first.
 */
export function jcsSerialize(value: JsonValue): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)

  if (Array.isArray(value)) {
    return `[${value.map(jcsSerialize).join(',')}]`
  }

  if (typeof value === 'object') {
    const keys = Object.keys(value).sort()
    const members = keys.map(
      (key) => `${JSON.stringify(key)}:${jcsSerialize(value[key] as JsonValue)}`,
    )
    return `{${members.join(',')}}`
  }

  throw new AuditCanonicalizationError(
    `a ${typeof value} is not permitted in an audit record (ADR-0020 §2). Call assertJcsSafe first.`,
  )
}

/** The twelve columns ADR-0020 §4 hashes, and no others. Order is not significant here — jcsSerialize sorts keys. */
export interface CanonicalAuditRecord {
  readonly id: string
  readonly tenant_id: string
  readonly seq: string
  readonly occurred_at: string
  readonly actor_user_id: string | null
  readonly action: string
  readonly entity_type: string
  readonly entity_id: string | null
  readonly before_json: JsonValue
  readonly after_json: JsonValue
  readonly ip: string | null
  readonly request_id: string | null
}

export const HASH_VERSION = 'v1' as const

/** 64 ASCII '0' characters — the genesis constant a seq=1 row's previous_hash must equal. */
export const GENESIS_HASH = '0'.repeat(64)

const UNIT_SEPARATOR = Buffer.from([0x1f])

/**
 * ADR-0020 §4, byte for byte:
 *
 *   hash = hex(SHA-256(previous_hash_ascii || 0x1F || version_ascii || 0x1F || jcs_utf8))
 *
 * `previousHash` must already be 64 lowercase hex ASCII characters (the
 * GENESIS_HASH constant for the row at seq=1). `record` is the twelve-column
 * canonical record with every leaf already a string or null — see
 * buildCanonicalRecord for turning raw application values into that form.
 */
export function computeAuditHash(
  previousHash: string,
  record: CanonicalAuditRecord,
  version: string = HASH_VERSION,
): { readonly hash: string; readonly jcs: string } {
  if (!/^[0-9a-f]{64}$/.test(previousHash)) {
    throw new AuditCanonicalizationError(
      `previousHash must be 64 lowercase hex characters (or GENESIS_HASH), got "${previousHash}"`,
    )
  }

  const jcs = jcsSerialize(record as unknown as JsonValue)
  const framed = Buffer.concat([
    Buffer.from(previousHash, 'ascii'),
    UNIT_SEPARATOR,
    Buffer.from(version, 'ascii'),
    UNIT_SEPARATOR,
    Buffer.from(jcs, 'utf8'),
  ])

  return { hash: createHash('sha256').update(framed).digest('hex'), jcs }
}
