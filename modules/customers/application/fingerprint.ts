import { createHash } from 'node:crypto'

/*
 * The create-idempotency fingerprint. modules.md §9: "SHA-256 of the JCS
 * serialisation of the parsed, normalised command, plus the route and the
 * target id." Same key + same fingerprint -> replay (the original
 * customer). Same key + a DIFFERENT fingerprint -> IDEMPOTENCY_KEY_REUSED.
 *
 * A local canonical-JSON stringify (sorted object keys, no whitespace) —
 * deliberately not `@finsoft/database`'s `computeRequestFingerprint`, whose
 * FingerprintInput shape is the posting engine's five-field tuple
 * (event/referenceType/referenceId/occurredAt/actorUserId), not a fit for a
 * create command that is none of those things. Same reasoning as that
 * function's own header note about not reusing `jcsSerialize`: canonical
 * JSON for request identity is a smaller job than ADR-0020's audit-chain
 * canonicalisation, and coupling the two would make an audit-chain rule
 * (no bare numbers/booleans) an accidental idempotency rule too.
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
  throw new Error(`computeCommandFingerprint: cannot canonicalize a value of type ${typeof value}.`)
}

export interface CommandFingerprintInput {
  readonly route: string
  readonly targetId: string | null
  readonly command: unknown
}

/** sha256 hex (64 chars) — matches customers.create_fingerprint's CHECK. */
export function computeCommandFingerprint(input: CommandFingerprintInput): string {
  const canonical = canonicalize({
    route: input.route,
    targetId: input.targetId,
    command: input.command,
  })
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}
