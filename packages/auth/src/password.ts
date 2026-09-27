import { randomBytes } from 'node:crypto'
import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2'

/*
 * Argon2id hashing and constant-time verification. ADR-0023 §4,
 * docs/WAVE_1_REGISTER.md's benchmark.
 *
 * Parameters are the ones benchmarked on the staging host, in a container
 * limited to 2 CPU / 1 GB — the shape the API runs in. Memory cost is the
 * denial-of-service lever here, not the security lever: login is
 * unauthenticated, so every concurrent attempt allocates its memory cost
 * before anything has proved who the caller is. 19 MiB keeps twenty
 * concurrent logins at ~380 MiB rather than 1.28 GB.
 */

const MEMORY_COST = 19_456
const TIME_COST = 3
const PARALLELISM = 1

export const ARGON2_PARAMS = {
  memoryCost: MEMORY_COST,
  timeCost: TIME_COST,
  parallelism: PARALLELISM,
}

export async function hashPassword(password: string): Promise<string> {
  return argon2Hash(password, ARGON2_PARAMS)
}

/*
 * ---------------------------------------------------------------------
 * The concurrency semaphore
 *
 * Rate limiting is per-origin; a distributed burst still converges on one
 * process. This bounds PEAK MEMORY regardless of how the requests arrived —
 * the control that makes the OOM arithmetic in the Wave 1 register's
 * benchmark a ceiling rather than a hope.
 * ---------------------------------------------------------------------
 */

const MAX_CONCURRENT_HASHES = 8

let inFlight = 0
const waiters: Array<() => void> = []

async function acquire(): Promise<void> {
  if (inFlight < MAX_CONCURRENT_HASHES) {
    inFlight += 1
    return
  }
  await new Promise<void>((resolve) => waiters.push(resolve))
  inFlight += 1
}

function release(): void {
  inFlight -= 1
  const next = waiters.shift()
  if (next) next()
}

async function withHashingSemaphore<T>(fn: () => Promise<T>): Promise<T> {
  await acquire()
  try {
    return await fn()
  } finally {
    release()
  }
}

/*
 * ---------------------------------------------------------------------
 * The decoy hash
 *
 * Computed ONCE, at process start, from a CSPRNG value, using the LIVE
 * parameter object — the same one the real verifier uses. A decoy baked in
 * with yesterday's parameters becomes an oracle the day they are tuned
 * (ADR-0023 §4 item 2). One decoy shared by every account-bearing endpoint
 * in the process: four independently initialised decoys would reintroduce
 * the parameter-drift oracle this exists to close.
 * ---------------------------------------------------------------------
 */

let decoyHashPromise: Promise<string> | undefined

function decoyHash(): Promise<string> {
  decoyHashPromise ??= argon2Hash(randomBytes(32).toString('hex'), ARGON2_PARAMS)
  return decoyHashPromise
}

/** For tests that want to assert the decoy is recomputed under new parameters. */
export function resetDecoyForTests(): void {
  decoyHashPromise = undefined
}

let verificationCount = 0

/** Test-only instrumentation: "exactly one argon2id invocation per request" is asserted by counting. */
export function verificationCountForTests(): number {
  return verificationCount
}

export function resetVerificationCountForTests(): void {
  verificationCount = 0
}

/**
 * Exactly one argon2id verification, always (ADR-0023 §4 item 1).
 *
 * `storedHash === null` covers two cases that must be indistinguishable from
 * the outside: no user exists at this address, and a user exists but has
 * never set a password (`INVITED`, or `SUSPENDED`/`DISABLED` with no hash).
 * Both verify against the decoy and both return `false` — never `true`,
 * regardless of what the caller supplies, because there is no real hash to
 * match.
 */
export async function verifyCredential(
  storedHash: string | null,
  password: string,
): Promise<boolean> {
  const hashToVerify = storedHash ?? (await decoyHash())
  verificationCount += 1
  const matched = await withHashingSemaphore(() => argon2Verify(hashToVerify, password))
  return storedHash !== null && matched
}
