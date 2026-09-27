import { sql } from 'kysely'
import type { GlobalTx } from '../transaction.ts'
import { GENESIS_HASH, HASH_VERSION } from './canonical.ts'

/*
 * The per-tenant chain anchor: a synthetic seq=0 row, hash = 64 zeros,
 * previous_hash NULL. ADR-0020 §5.
 *
 * Without it, `MAX(seq) + 1` for a brand-new tenant returns NULL and the
 * first real append fails on a bare NOT NULL violation; and a row at seq=1
 * (whose previous_hash must equal GENESIS_HASH, per audit_log_genesis_ties)
 * has nothing for audit_log_prev_fkey to reference.
 *
 * `tx` is a GlobalTx because tenant provisioning has no tenant context yet —
 * ADR-0020 §5 calls this "the one write that is ordered before the tenant is
 * generally visible". `audit_log` is tenant-owned and therefore not
 * addressable through GlobalTx's Kysely typing (GlobalDatabase only exposes
 * the global-table allowlist), so this uses raw `sql`, exactly as
 * transaction.ts's own withTenant uses raw `sql` for set_config — a narrow,
 * reviewed exception to "always use the typed builder", not a general escape
 * hatch.
 */

function lockKeyExpr(tenantId: string) {
  // LOCK_REGISTRY.md position 6. Both 64-bit halves of the tenant id are
  // XORed together — folding only the first 64 bits collapses every
  // structured test fixture (…-4000-8000-000000000001/2/3…) to the same key.
  return sql`
    ( ('x' || substr(replace(${tenantId}::text, '-', ''),  1, 16))::bit(64)::bigint
    # ('x' || substr(replace(${tenantId}::text, '-', ''), 17, 16))::bit(64)::bigint )
  `
}

/**
 * Create the seq=0 anchor for `tenantId`, in the SAME transaction as the
 * `tenants` insert.
 *
 * No production tenant-provisioning code exists yet in this repository — see
 * the note at the top of database/migrations/009_create_audit_log.sql.
 * `packages/database/src/testing/harness.ts`'s `createTenantFixture` calls
 * this today, so every fixture tenant used by any test suite has a valid
 * chain. Whoever builds real provisioning must call this in the same
 * transaction as the `tenants` insert, before returning — never afterwards in
 * a second transaction, or a crash between the two leaves a tenant that can
 * never append an audit record.
 */
export async function createAuditChainAnchor(tx: GlobalTx, tenantId: string): Promise<void> {
  // TD-001: named and set here too, for the same reason as writer.ts —
  // provisioning takes the same terminal advisory lock.
  await sql`select set_config('lock_timeout', '2000ms', true)`.execute(tx)
  await sql`select pg_advisory_xact_lock(${lockKeyExpr(tenantId)})`.execute(tx)
  await sql`select set_config('app.tenant_id', ${tenantId}, true)`.execute(tx)

  await sql`
    INSERT INTO audit_log (
      tenant_id, seq, occurred_at, actor_user_id, action, entity_type, entity_id,
      before_json, after_json, ip, request_id, hash_version, hash, previous_hash
    ) VALUES (
      ${tenantId}, 0, now(), NULL, 'AUDIT_CHAIN_ANCHOR', 'audit_chain', NULL,
      NULL, NULL, NULL, NULL, ${HASH_VERSION}, ${GENESIS_HASH}, NULL
    )
  `.execute(tx)
}

export { lockKeyExpr as auditChainLockKeyExpr }
