/*
 * Redaction.
 *
 * NON_NEGOTIABLES rule 20: secrets are never committed, never logged, never
 * printed. A logger is the most likely place in the system to break that rule,
 * because logging is the one thing people add in a hurry while debugging
 * something else.
 *
 * The defence is deliberately three-layered, because each layer has a failure
 * mode the others cover:
 *
 *   1. KEY NAME  — `password`, `token`, `authorization`. Catches the common
 *                  case, fails when a field is named something unexpected.
 *   2. VALUE SHAPE — anything that looks like a JWT or a bearer credential,
 *                  whatever the key is called. Catches a secret smuggled in
 *                  under an innocent name, including one inside a string.
 *   3. ERROR SANITISING — connection errors from `pg` carry host, port,
 *                  database and role. Those are not "secrets" by key name and
 *                  have no token shape, so layers 1 and 2 both miss them.
 *
 * Redaction happens on the way INTO the logger, not at the aggregator. A
 * secret that reaches the log file has already leaked; scrubbing it later
 * removes the evidence, not the exposure.
 */

export const REDACTED = '[redacted]'

/*
 * Key names whose value is never logged, compared after stripping everything
 * that is not a letter or a digit — so `access_token`, `accessToken`,
 * `ACCESS-TOKEN` and `access token` all collapse to `accesstoken`.
 *
 * `hash` is deliberately NOT here: the audit chain hash (rule 9) is not a
 * secret and redacting it would break the tamper-evidence trail. `passwordhash`
 * is caught by the substring rule below.
 */
const DENIED_KEYS: readonly string[] = [
  'password',
  'passwd',
  'pwd',
  'secret',
  'clientsecret',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'apikey',
  'authorization',
  'cookie',
  'setcookie',
  'jwt',
  'bearer',
  'privatekey',
  'credential',
  'credentials',
  'salt',
  'otp',
  'totp',
  'mfacode',
  'pin',
  'cvv',
  'cardnumber',
  'iban',
  'connectionstring',
  'databaseurl',
  'dsn',
  /*
   * Session identifiers. The raw session id is a bearer credential: anyone
   * holding it can resume the session. It is never logged under any name.
   * `sessionCorrelationId` is the approved, non-secret substitute and is
   * explicitly allowed below.
   */
  'sessionid',
  'session',
  'sid',
  'sessiontoken',
]

/*
 * Keys that survive the substring test below even though they contain a denied
 * word. Each one is an explicit, reviewed decision.
 */
const ALLOWED_KEYS: readonly string[] = [
  /*
   * The approved non-secret correlation identifier (see context.ts). It is
   * minted per session, is not a credential, and cannot be used to resume a
   * session — which is the whole reason it exists.
   */
  'sessioncorrelationid',
]

const normaliseKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, '')

export function isDeniedKey(key: string): boolean {
  const k = normaliseKey(key)
  if (ALLOWED_KEYS.includes(k)) return false
  if (DENIED_KEYS.includes(k)) return true
  /*
   * Substring match, so `userPassword`, `db_password_hash` and
   * `supplierApiKeyV2` are all caught. This is why ALLOWED_KEYS has to exist:
   * `sessionCorrelationId` contains `session`.
   */
  return DENIED_KEYS.some((denied) => k.includes(denied))
}

/*
 * Layer 2. A JSON Web Token is three base64url segments separated by dots, and
 * the first decodes to a JSON header — so the `eyJ` prefix is near-universal in
 * practice. Matching the shape catches a token logged as `context`, `payload`
 * or `data`, which is how they actually escape.
 */
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g
const BEARER_PATTERN = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi

/*
 * Credentials embedded in a URL: postgresql://user:password@host/db, and the
 * same shape for redis://, amqp://, mongodb:// and https:// with basic auth.
 *
 * Found by a test, not by reasoning. A `pg` connection failure puts the whole
 * DSN in its MESSAGE — `could not connect to
 * postgresql://finsoft_app:hunter2@db.internal:5432/finsoft` — so layer 3
 * stripped the topology FIELDS from the error object while the message string
 * sailed through untouched, password and all, into the log.
 *
 * Only the credentials are removed. The scheme and host survive, because
 * "could not connect to [redacted]" tells an on-call engineer nothing, and a
 * redaction that destroys the diagnosis is one that gets switched off.
 */
const URL_CREDENTIALS_PATTERN = /\b([a-z][a-z0-9+.-]*):\/\/[^\s:@/]+:[^\s@/]+@/gi

/*
 * A secret as a key=value pair in free text. Two shapes, one pattern:
 *
 *   a query parameter      ...?token=abc123&retry=1
 *   a libpq connection     host=db user=finsoft_app password=hunter2
 *
 * Both are credential locations a URL-only pattern misses entirely, and the
 * libpq keyword/value form is what `pg` itself accepts and what appears in
 * PGPASSWORD-adjacent diagnostics.
 *
 * The VALUE is replaced and the KEY is kept, so the line still says which
 * credential was involved — "password=[redacted]" is diagnosable,
 * "[redacted]" is not.
 */
const KEY_VALUE_SECRET_PATTERN =
  /\b(password|passwd|pwd|secret|client_secret|token|access_token|refresh_token|id_token|api[_-]?key|apikey|auth|authorization|signature|sig|sessionid|session_token)\s*=\s*("[^"]*"|'[^']*'|[^\s&;#,)]+)/gi

/**
 * Value-shape redaction, applied to every string that reaches the logger —
 * message, interpolation argument, nested object value, error message and
 * stack frame alike.
 *
 * Policy, checked against NON_NEGOTIABLES rule 20 ("never in a log line")
 * rather than chosen by regex convenience:
 *
 *   CREDENTIALS are removed from the entire emitted line, wherever they
 *   appear — message, stack, nested `cause`, query parameter, connection
 *   string, any scheme.
 *
 *   TOPOLOGY — host, port, database name, role — is not a credential. It is
 *   removed from the structured error FIELDS, where it is machine-readable
 *   and trivial to harvest in bulk, and kept in free text, because
 *   "could not connect to [redacted]" tells an on-call engineer nothing and
 *   a redaction that destroys the diagnosis is one that gets switched off.
 *
 *   SAFE DIAGNOSTIC CODES — ECONNREFUSED, ETIMEDOUT, SQLSTATE — are always
 *   preserved. They are the reason the line exists.
 */
export function redactValueShapes(value: string): string {
  return value
    .replace(JWT_PATTERN, REDACTED)
    .replace(BEARER_PATTERN, REDACTED)
    .replace(URL_CREDENTIALS_PATTERN, `$1://${REDACTED}@`)
    .replace(KEY_VALUE_SECRET_PATTERN, `$1=${REDACTED}`)
}

/*
 * Bounds. A log line is not a data export: a caller that hands the logger a
 * 50 MB object should get a truncated line, not an out-of-memory process at
 * 3am. These also terminate on cyclic structures, which a naive walk does not.
 */
const MAX_DEPTH = 8
const MAX_ARRAY_LENGTH = 100
const MAX_STRING_LENGTH = 4_096
const MAX_KEYS = 200

export const TRUNCATED = '[truncated]'
export const CIRCULAR = '[circular]'
export const TOO_DEEP = '[max-depth]'

function truncateString(value: string): string {
  const redacted = redactValueShapes(value)
  return redacted.length > MAX_STRING_LENGTH
    ? `${redacted.slice(0, MAX_STRING_LENGTH)}…${TRUNCATED}`
    : redacted
}

/**
 * Deep-redacts an arbitrary value for logging.
 *
 * pino's own `redact` option takes explicit paths and does not match by key
 * name at arbitrary depth, so it cannot express "no field called `password`
 * anywhere, ever". This walk can, and it runs on every log object.
 */
export function redact(input: unknown, seen: WeakSet<object> = new WeakSet(), depth = 0): unknown {
  if (input === null || input === undefined) return input

  if (typeof input === 'string') return truncateString(input)
  if (typeof input === 'number' || typeof input === 'boolean') return input
  if (typeof input === 'bigint') return input.toString()
  if (typeof input === 'function') return '[function]'
  if (typeof input === 'symbol') return input.toString()

  if (input instanceof Date) return input.toISOString()
  if (input instanceof Error) return redactError(input)

  if (depth >= MAX_DEPTH) return TOO_DEEP

  if (typeof input === 'object') {
    if (seen.has(input)) return CIRCULAR
    seen.add(input)

    if (Array.isArray(input)) {
      const items = input.slice(0, MAX_ARRAY_LENGTH).map((item) => redact(item, seen, depth + 1))
      if (input.length > MAX_ARRAY_LENGTH) items.push(`${TRUNCATED} ${input.length} items`)
      return items
    }

    const out: Record<string, unknown> = {}
    let count = 0
    for (const [key, value] of Object.entries(input)) {
      if (count >= MAX_KEYS) {
        out[TRUNCATED] = `${Object.keys(input).length} keys`
        break
      }
      out[key] = isDeniedKey(key) ? REDACTED : redact(value, seen, depth + 1)
      count += 1
    }
    return out
  }

  return String(input)
}

/*
 * Layer 3.
 *
 * A `pg` connection error carries `host`, `port`, `database` and the role it
 * tried to authenticate as. None of that trips a key-name or token-shape check,
 * and all of it is infrastructure detail that does not belong in an
 * aggregated log — still less in an HTTP response (rule 20, and the reason
 * health.service.ts keeps its public detail generic).
 */
const ERROR_FIELDS_DROPPED: readonly string[] = [
  'host',
  'port',
  'database',
  'user',
  'username',
  'address',
  'hostname',
  'connectionString',
  'config',
  'client',
  'query',
  'sql',
  'parameters',
  'values',
]

export interface SanitisedError {
  readonly name: string
  readonly message: string
  readonly code?: string
  readonly stack?: string
  readonly cause?: unknown
}

/**
 * Turns an error into something safe to log.
 *
 * Keeps what makes an incident diagnosable — name, message, driver error code,
 * stack — and drops the connection topology. The message is still passed
 * through value-shape redaction, because a driver will happily interpolate a
 * connection string into one.
 */
export function redactError(error: unknown): SanitisedError {
  if (!(error instanceof Error)) {
    return { name: 'NonError', message: truncateString(String(error)) }
  }

  const raw = error as Error & Record<string, unknown>
  const out: Record<string, unknown> = {
    name: raw.name,
    message: truncateString(raw.message),
  }

  if (typeof raw.code === 'string') out.code = raw.code
  if (typeof raw.stack === 'string') out.stack = truncateString(raw.stack)

  /*
   * Any other own enumerable property is kept only if it is not a dropped
   * connection field and not a denied key. A driver that attaches useful
   * context (`constraint`, `table`, `severity`) keeps it; one that attaches
   * the DSN does not.
   */
  for (const [key, value] of Object.entries(raw)) {
    if (key in out) continue
    if (ERROR_FIELDS_DROPPED.includes(key) || isDeniedKey(key)) continue
    out[key] = redact(value)
  }

  if (raw.cause !== undefined) out.cause = redactError(raw.cause)

  return out as unknown as SanitisedError
}
