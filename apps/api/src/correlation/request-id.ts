import { randomUUID } from 'node:crypto'

/*
 * Request id validation. M1-C, ARCHITECTURE §10, ADR-0020 §4 (`audit_log.request_id`).
 *
 * The inbound `X-Request-Id` header is client-controlled, and it ends up in
 * two places that matter: every log line for the request (packages/
 * observability's correlation context) and — once a posting-style handler
 * writes one — an append-only, hash-chained audit row. Neither may take
 * arbitrary client text. A client that sends `X-Request-Id: '; DROP TABLE
 * audit_log; --` or a 64 KiB string is not naming a correlation id, and
 * accepting it verbatim would let an untrusted value ride into a structured
 * log field (and, on a posting path, get lowercased and hashed into the
 * chain — canonical.ts's `assertJcsSafe` does not run on `request_id`, which
 * is a plain column, not a JSON payload).
 *
 * The rule is therefore narrow: the header is trusted ONLY if it is already
 * a well-formed UUID (any RFC 4122 version/variant — an upstream system may
 * hand this process a v1 or v7 id, not only the v4 this process itself
 * mints). Anything else — missing, malformed, oversized, an array from a
 * repeated header — is replaced with a freshly minted v4 id. The request is
 * never rejected for a bad id; a correlation id is a convenience for
 * debugging, not a credential or a business input, so the correct response
 * to a malformed one is to mint a good one, not to fail the request.
 */

/**
 * RFC 4122 textual form: 8-4-4-4-12 hex digits. Deliberately NOT restricted
 * to version 4 (the `newRequestId()`/`randomUUID()` shape this process
 * mints) — a request id arriving from an upstream caller's own correlation
 * scheme is still a valid id to adopt, as long as it is actually a UUID and
 * not arbitrary client text.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * True only for a single string that is exactly a well-formed UUID — never
 * for an array (a client sending the header twice), never for a UUID
 * embedded in a longer string (the pattern is anchored at both ends).
 */
export function isWellFormedRequestId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

/**
 * Resolves the request id for one inbound request from the raw
 * `X-Request-Id` header value (as Express hands it back — `string`,
 * `string[]` for a repeated header, or `undefined` when absent).
 *
 * Trusts the header only if well-formed, and normalises it to lowercase —
 * matching `buildCanonicalRecord`'s own lowercasing of `request_id` before
 * it is hashed (packages/database/src/audit/record.ts), so the id that
 * appears in the response header, the logs and the audit row is the exact
 * same text throughout. Every other case mints a fresh `randomUUID()`.
 */
export function resolveRequestId(header: string | readonly string[] | undefined): string {
  if (isWellFormedRequestId(header)) {
    return header.toLowerCase()
  }
  return randomUUID()
}
