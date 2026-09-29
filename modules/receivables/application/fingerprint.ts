import { createHash } from 'node:crypto'

/*
 * The request-identity fingerprint for every idempotency key this module
 * checks itself (create draft, post, reverse — modules.md §9). SHA-256 of
 * the JCS-style canonical serialisation of (route, targetId, command).
 * Deliberately not `@finsoft/database`'s `computeRequestFingerprint`, whose
 * shape is the posting engine's own five-field tuple — same reasoning as
 * modules/customers/application/fingerprint.ts's own header, duplicated
 * here rather than imported: `customers/application/*` is not a
 * cross-module import target (only `published.ts` is, ADR-0028 statement 3).
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

/** sha256 hex (64 chars) — matches the migrations' `*_fingerprint` CHECKs. */
export function computeCommandFingerprint(input: CommandFingerprintInput): string {
  const canonical = canonicalize({
    route: input.route,
    targetId: input.targetId,
    command: input.command,
  })
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}
