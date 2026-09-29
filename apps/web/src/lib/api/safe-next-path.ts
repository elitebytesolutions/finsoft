/*
 * Guards the one place `?next=` ever reaches the router. Security review
 * (this task): an unauthenticated redirect to `/login?next=<anything>`
 * followed by a successful sign-in — or nothing more than the silent
 * refresh on a later page load — handed that value straight to
 * `navigate()` (apps/web/src/lib/router.tsx), which calls Next's
 * `router.replace`/`router.push`. Next treats a string that resolves to a
 * different origin as a real, off-site navigation, so
 * `/login?next=https://evil.example/login` or `?next=//evil.example` sent a
 * signed-in user straight off this application with no further action from
 * them at all.
 *
 * `next` is written by whoever constructs the link — an attacker, not this
 * application — so it is validated HERE, at the point it is about to be
 * used, never trusted because it was merely read. Reading it earlier and
 * checking it later is exactly the gap that let this through.
 */

/**
 * Reads a query parameter's RAW value — still percent-encoded, exactly as it
 * appeared in the URL — from a query string. `URLSearchParams.get()` would
 * decode it for us, which is usually what you want and is exactly what we do
 * NOT want here: `safeNextPath` below needs to own the single decode pass
 * itself, so a value that arrives already decoded once (by whatever called
 * this) and is decoded again there cannot happen. First match wins, matching
 * `URLSearchParams.get()`'s own behaviour for a repeated key.
 */
export function rawSearchParam(search: string, key: string): string | null {
  const query = search.startsWith('?') ? search.slice(1) : search
  if (!query) return null

  for (const pair of query.split('&')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    const rawKey = eq === -1 ? pair : pair.slice(0, eq)
    let decodedKey: string
    try {
      decodedKey = decodeURIComponent(rawKey.replace(/\+/g, ' '))
    } catch {
      decodedKey = rawKey
    }
    if (decodedKey === key) return eq === -1 ? '' : pair.slice(eq + 1)
  }
  return null
}

const SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:/i

/**
 * True if `value` contains a C0 control character (U+0000-U+001F) or DEL
 * (U+007F). Written as a character-code scan rather than a `[\x00-\x1f]`
 * regex — eslint's `no-control-regex` (correctly) flags that pattern in
 * general, since a literal control character in a regex is almost always a
 * mistake; here it is the entire point, so the scan avoids arguing with the
 * rule instead of suppressing it.
 */
function containsControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

/**
 * Validates a redirect target: accepted only if it is a same-origin relative
 * path starting with exactly one `/`. Rejects `//...` (protocol-relative —
 * resolves against the current scheme, to a different host), any backslash
 * anywhere (browsers normalise `/\...` — and in some contexts `\...` — to a
 * path separator too, so a leading-slash-only check is not enough), any
 * scheme (`https:`, `javascript:`, ...), control characters, and
 * percent-encoded variants of all of the above (`%2F%2F`, `%5C`) — decoded
 * exactly once, so a doubly-encoded payload cannot sail through a check that
 * only ever looks at the string before its LAST decode.
 *
 * `rawValue` is expected to be the value's RAW, still-encoded form —
 * `rawSearchParam` above gives you that. Anything that fails validation, or
 * that cannot even be decoded (malformed percent-encoding), falls back to
 * `fallback`.
 */
export function safeNextPath(rawValue: string | null | undefined, fallback = '/dashboard'): string {
  if (!rawValue) return fallback

  let decoded: string
  try {
    decoded = decodeURIComponent(rawValue)
  } catch {
    return fallback
  }

  if (containsControlCharacter(decoded)) return fallback
  if (!decoded.startsWith('/')) return fallback
  if (decoded.startsWith('//')) return fallback
  if (decoded.includes('\\')) return fallback
  if (SCHEME_PREFIX.test(decoded)) return fallback

  return decoded
}
