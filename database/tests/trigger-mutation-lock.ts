import type { Client } from 'pg'

/*
 * Test-only serialisation for anything that ALTERs a trigger's enabled state
 * on audit_log.
 *
 * `ALTER TABLE ... DISABLE/ENABLE TRIGGER` is DDL: it commits immediately
 * (it is not scoped to the caller's own transaction the way row data is) and
 * is visible to every other connection the instant it commits. Vitest runs
 * this directory's files sequentially (database/tests/vitest.config.ts,
 * fileParallelism: false) specifically because of this hazard, but that
 * alone was measured NOT to be sufficient: file-boundary scheduling still let
 * database/tests/audit-log.spec.ts's "both triggers enabled" assertion
 * observe audit-log-concurrency.spec.ts's disabled window and fail
 * non-deterministically.
 *
 * This is a completely different lock from the audit chain's own terminal
 * advisory lock (LOCK_REGISTRY.md position 6, keyed on the folded tenant id)
 * — this one is TEST INFRASTRUCTURE, never taken by application code, and it
 * exists so that no two things in this test suite can have audit_log's
 * triggers in a disabled state, or be asserting they are all enabled, at the
 * same instant.
 *
 * THE KEY IS A FIXED CONSTANT, NOT "FAR OUTSIDE" THE REAL KEY SPACE — an
 * earlier version of this comment claimed that, and it was wrong: position
 * 6's fold produces a full 64-bit signed integer from ANY tenant uuid, so
 * every value in that range — including this one — is a value SOME tenant
 * could fold to. There is no subrange this constant can sit "outside" of.
 * What actually makes a collision negligible is that this key occupies ONE
 * point in a ~1.8×10^19-point space (2^64), so the chance any given
 * tenant's folded key equals it by accident is about 1 in 2^64 — the same
 * order of collision risk LOCK_REGISTRY.md's own position-6 fold accepts for
 * real tenants colliding with EACH OTHER. Registered in LOCK_REGISTRY.md so
 * it is a fact someone can check, not a claim in a comment only this file
 * makes.
 */
const TEST_TRIGGER_MUTATION_LOCK_KEY = 918_273_645

export async function withTriggersLocked<T>(client: Client, fn: () => Promise<T>): Promise<T> {
  await client.query('SELECT pg_advisory_lock($1)', [TEST_TRIGGER_MUTATION_LOCK_KEY])
  try {
    return await fn()
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [TEST_TRIGGER_MUTATION_LOCK_KEY])
  }
}

/**
 * For a file where EVERY test's assertion depends on some audit_log trigger
 * being enabled (audit-log.spec.ts, audit-verifier.spec.ts): acquire in
 * `beforeEach`, release in `afterEach`, so nothing in the file needs to be
 * individually identified as vulnerable. A single missed assertion is
 * exactly how this class of flake survived two rounds of targeted fixes
 * before this file adopted the blanket form.
 */
export function acquireTriggerLock(client: Client): Promise<unknown> {
  return client.query('SELECT pg_advisory_lock($1)', [TEST_TRIGGER_MUTATION_LOCK_KEY])
}

export function releaseTriggerLock(client: Client): Promise<unknown> {
  return client.query('SELECT pg_advisory_unlock($1)', [TEST_TRIGGER_MUTATION_LOCK_KEY])
}
