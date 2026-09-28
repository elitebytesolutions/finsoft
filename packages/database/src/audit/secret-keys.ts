import type { JsonValue } from './canonical.ts'

/*
 * S2 (Security review). rule 20 forbids secrets in logs; audit_log is
 * read by readonly_support, sits in every backup, and is never deleted
 * (rule 4) — a secret written into before_json/after_json is a rule 20
 * breach that outlives the incident that caused it, permanently, because
 * this table cannot be redacted after the fact (append-only) or purged
 * (no DELETE).
 *
 * recordAudit therefore rejects — not redacts — any key whose NAME matches
 * this pattern, at any nesting depth, in either before_json or after_json.
 * Redaction was considered and rejected: a caller that believes it is
 * passing a password gets a loud, named error naming the exact key path,
 * so the bug is fixed at the call site rather than silently replaced with
 * "[REDACTED]" — which would look like the control worked while still
 * shipping a broken caller that "just" logs something else sensitive next
 * time under a key this pattern happens not to catch.
 */

const SECRET_LIKE_KEY_PATTERN =
  /pass(word)?|secret|token|refresh|otp|totp|recovery|api_?key|authori[sz]ation|cookie|session_?id|_hash$/i

export class AuditSecretKeyError extends Error {
  readonly path: string
  readonly key: string

  constructor(path: string, key: string) {
    super(
      `${path}: the key "${key}" looks like it holds a secret (matches ` +
        `${SECRET_LIKE_KEY_PATTERN.toString()}). Rule 20: audit_log is never deleted and is read by ` +
        'readonly_support and every backup — a secret written here cannot be un-written. Remove this ' +
        "key from the event you pass to recordAudit, or rename it if it genuinely isn't a secret " +
        '(e.g. "password_changed" rather than "password").',
    )
    this.name = 'AuditSecretKeyError'
    this.path = path
    this.key = key
  }
}

/** Recursively reject any object key matching the secret-like pattern, at any depth, in either JSON payload. */
export function assertNoSecretLikeKeys(value: JsonValue, path = '$'): void {
  if (value === null || typeof value === 'string') return

  if (Array.isArray(value)) {
    value.forEach((element, index) => assertNoSecretLikeKeys(element, `${path}[${index}]`))
    return
  }

  if (typeof value === 'object') {
    for (const [key, element] of Object.entries(value)) {
      if (SECRET_LIKE_KEY_PATTERN.test(key)) {
        throw new AuditSecretKeyError(path, key)
      }
      assertNoSecretLikeKeys(element, `${path}.${key}`)
    }
  }
}
