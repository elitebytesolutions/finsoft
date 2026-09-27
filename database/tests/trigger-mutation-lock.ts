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
 * — this one is TEST INFRASTRUCTURE, never taken by application code, keyed
 * on a fixed constant chosen far outside any real tenant-id-derived value's
 * range, and it exists so that no two things in this test suite can have
 * audit_log's triggers in a disabled state, or be asserting they are all
 * enabled, at the same instant.
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
