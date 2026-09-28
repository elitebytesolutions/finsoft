import { randomUUID } from 'node:crypto'
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  importPKCS8,
  importSPKI,
  jwtVerify,
  type JWK,
} from 'jose'

/*
 * JWT issuing and verification. ADR-0009.
 *
 * RS256 only, explicitly ("the caller must state the permitted algorithms" —
 * Wave 1 register's reason for choosing `jose` over `jsonwebtoken`): a
 * request carrying `alg: none`, or an RS256 token presented as HS256 with
 * the public key as the "secret", is rejected before any claim is read,
 * because the `algorithms` option below is checked independently of
 * whatever the token's own header claims.
 *
 * Access tokens are ~15 minutes, carry `sub`, `tenant_id`, `session_id`,
 * `perm_ver`, `mfa`, `jti`, and are verified against `iss`/`aud`/`exp`/`nbf`.
 * `tenant_id` is the ADR-0009:67 claim the whole isolation model rests on: it
 * is set at sign time from a value that itself came from a resolver
 * (ADR-0023 §3), never from request input, and a modified claim invalidates
 * the signature.
 */

type Key = Awaited<ReturnType<typeof generateKeyPair>>['privateKey']

const ALG = 'RS256' as const
const ISSUER = 'finsoft'
const AUDIENCE = 'finsoft-api'

/** ~15 minutes (ADR-0009:45). */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60

interface KeySet {
  readonly signingKid: string
  readonly privateKey: Key
  readonly verifiers: ReadonlyMap<string, Key>
  readonly jwks: { readonly keys: readonly JWK[] }
}

interface PublicKeyEntry {
  readonly kid: string
  readonly pem: string
}

/**
 * C1: the ephemeral dev/test key path is an ALLOWLIST of exactly two
 * `NODE_ENV` values, not a denylist of `production` — an UNSET `NODE_ENV`
 * (a misconfigured deploy, a staging box someone forgot to set it on) must
 * not silently qualify for "not production" and get a key pair that
 * evaporates on every restart. Real keys are required unless `NODE_ENV` is
 * exactly `development` or `test`.
 */
function ephemeralKeysAllowed(): boolean {
  const env = process.env['NODE_ENV']
  return env === 'development' || env === 'test'
}

async function buildKeySet(): Promise<KeySet> {
  const privatePem = process.env['AUTH_JWT_PRIVATE_KEY']
  const publicKeysJson = process.env['AUTH_JWT_PUBLIC_KEYS']

  if (privatePem) {
    const signingKid = process.env['AUTH_JWT_KID']
    if (!signingKid) {
      throw new Error('AUTH_JWT_KID is required alongside AUTH_JWT_PRIVATE_KEY')
    }
    if (!publicKeysJson) {
      throw new Error('AUTH_JWT_PUBLIC_KEYS is required alongside AUTH_JWT_PRIVATE_KEY')
    }

    const entries = JSON.parse(publicKeysJson) as readonly PublicKeyEntry[]
    const privateKey = await importPKCS8(privatePem, ALG)
    const verifiers = new Map<string, Key>()
    const jwks: JWK[] = []

    for (const entry of entries) {
      const key = await importSPKI(entry.pem, ALG)
      verifiers.set(entry.kid, key)
      const jwk = await exportJWK(key)
      jwks.push({ ...jwk, kid: entry.kid, alg: ALG, use: 'sig' })
    }

    if (!verifiers.has(signingKid)) {
      throw new Error(
        `AUTH_JWT_KID "${signingKid}" is not present among AUTH_JWT_PUBLIC_KEYS — rotation ` +
          "requires the signing key's own public half to be published, or nothing can verify " +
          'a token minted after this restart.',
      )
    }

    return { signingKid, privateKey, verifiers, jwks: { keys: jwks } }
  }

  if (!ephemeralKeysAllowed()) {
    throw new Error(
      `AUTH_JWT_PRIVATE_KEY and AUTH_JWT_PUBLIC_KEYS are required when NODE_ENV is ` +
        `"${process.env['NODE_ENV'] ?? '(unset)'}". An ephemeral key pair is a dev/test ` +
        'convenience only, allowed exclusively when NODE_ENV is exactly "development" or ' +
        '"test" — an UNSET NODE_ENV does not qualify. It would make every token invalid ' +
        'across a restart and across every other instance in the fleet. See ' +
        'infrastructure/staging/RUNBOOK-finsoft-refresh-role.md for the one-time step to ' +
        'generate a real RSA key pair and set these variables.',
    )
  }

  // Dev/test only: one ephemeral RSA pair per process. Regenerated on every
  // restart, which is precisely why this path must never run outside those
  // two environments.
  const { publicKey, privateKey } = await generateKeyPair(ALG, {
    modulusLength: 2048,
    extractable: true,
  })
  const kid = randomUUID()
  const jwk = await exportJWK(publicKey)

  return {
    signingKid: kid,
    privateKey,
    verifiers: new Map([[kid, publicKey]]),
    jwks: { keys: [{ ...jwk, kid, alg: ALG, use: 'sig' }] },
  }
}

let keySetPromise: Promise<KeySet> | undefined

function keySet(): Promise<KeySet> {
  keySetPromise ??= buildKeySet()
  return keySetPromise
}

/** For tests that need a fresh ephemeral key set rather than the cached one. */
export function resetKeySetForTests(): void {
  keySetPromise = undefined
}

/**
 * C1: load (or generate) the key set eagerly, at process boot
 * (`apps/api/src/main.ts`), before the server starts accepting connections —
 * the same "refuse to boot rather than serve wrong" shape `main.ts` already
 * uses for the database pool and the cookie configuration. Without this, a
 * malformed `AUTH_JWT_PRIVATE_KEY`/`AUTH_JWT_PUBLIC_KEYS` pair, or a missing
 * `AUTH_JWT_KID`, is only discovered on the FIRST login or token
 * verification — a process that reports healthy and then fails every
 * authenticated request.
 */
export async function preloadJwtKeys(): Promise<void> {
  await keySet()
}

/** GET /api/auth/jwks. Public by design — this is what lets anything verify a token. */
export async function getJwks(): Promise<{ keys: readonly JWK[] }> {
  return (await keySet()).jwks
}

export interface AccessTokenClaims {
  readonly userId: string
  readonly tenantId: string
  readonly sessionId: string
  readonly permissionVersion: number
  readonly mfa: boolean
}

export interface SignedAccessToken {
  readonly token: string
  readonly expiresIn: number
}

export async function signAccessToken(claims: AccessTokenClaims): Promise<SignedAccessToken> {
  const { privateKey, signingKid } = await keySet()

  const token = await new SignJWT({
    tenant_id: claims.tenantId,
    session_id: claims.sessionId,
    perm_ver: claims.permissionVersion,
    mfa: claims.mfa,
  })
    .setProtectedHeader({ alg: ALG, kid: signingKid, typ: 'JWT' })
    .setSubject(claims.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setNotBefore(0)
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .setJti(randomUUID())
    .sign(privateKey)

  return { token, expiresIn: ACCESS_TOKEN_TTL_SECONDS }
}

export interface VerifiedAccessToken {
  readonly userId: string
  readonly tenantId: string
  readonly sessionId: string
  readonly permissionVersion: number
  readonly mfa: boolean
}

export class TokenVerificationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'TokenVerificationError'
  }
}

/**
 * Verifies signature, algorithm (pinned to RS256 regardless of the token's
 * own header), issuer, audience, expiry and not-before, then extracts the
 * claims the rest of the system trusts. Never returns a partially-verified
 * result: any failure — signature, algorithm confusion, `alg: none`, a
 * missing or wrong-typed claim — throws `TokenVerificationError`.
 */
export async function verifyAccessToken(token: string): Promise<VerifiedAccessToken> {
  const { verifiers } = await keySet()

  try {
    const { payload } = await jwtVerify(
      token,
      async (header) => {
        const kid = header.kid
        if (!kid) throw new TokenVerificationError('access token has no kid')
        const key = verifiers.get(kid)
        if (!key) throw new TokenVerificationError(`unknown kid "${kid}"`)
        return key
      },
      { algorithms: [ALG], issuer: ISSUER, audience: AUDIENCE },
    )

    const { sub, tenant_id: tenantId, session_id: sessionId, perm_ver: permVer, mfa } = payload

    if (
      typeof sub !== 'string' ||
      typeof tenantId !== 'string' ||
      typeof sessionId !== 'string' ||
      typeof permVer !== 'number' ||
      typeof mfa !== 'boolean'
    ) {
      throw new TokenVerificationError(
        'access token is missing a required claim or has the wrong type',
      )
    }

    return { userId: sub, tenantId, sessionId, permissionVersion: permVer, mfa }
  } catch (error) {
    if (error instanceof TokenVerificationError) throw error
    throw new TokenVerificationError('access token failed verification', { cause: error })
  }
}
