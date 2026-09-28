import { defineConfig } from 'vitest/config'

/*
 * database/tests runs against a single shared PostgreSQL instance
 * (TEST_DATABASE_URL), and audit-log-concurrency.spec.ts mutates GLOBAL
 * schema state for the duration of one test — `ALTER TABLE audit_log
 * DISABLE/ENABLE TRIGGER`, which is not scoped to a session or a
 * transaction and is visible to every other connection immediately.
 *
 * Vitest's default is to run test FILES in parallel across workers. Under
 * that default, another file's assertion that "both triggers are enabled"
 * can observe the window where this file has deliberately disabled one —
 * measured: running the full directory together intermittently failed
 * audit-log.spec.ts's tgenabled assertion with 'D' instead of 'O', purely
 * from file-scheduling, not from a defect in either file.
 *
 * `fileParallelism: false` mirrors tests/integration/vitest.config.ts, which
 * already solved the same class of problem (shared database, DATABASE_POOL_MAX
 * pinned to 1) for the same reason: a suite whose correctness depends on
 * mutating cluster-wide state must run one file at a time.
 */
export default defineConfig({
  test: {
    include: ['database/tests/**/*.spec.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
