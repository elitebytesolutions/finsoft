import {
  sql,
  type InsertObject,
  type SelectQueryBuilder,
  type SqlBool,
  type UpdateObject,
  type UpdateQueryBuilder,
} from 'kysely'
import type { Database, TenantTableName } from './schema.ts'
import { TenantContext } from './tenant-context.ts'
import { assertIssuedTenantTx, type TenantTx } from './transaction.ts'

/*
 * The base repository. ADR-0003:114, ARCHITECTURE §6.
 *
 * Layer three of four. RLS underneath is what makes a mistake here harmless;
 * this layer is what makes the mistake unlikely, keeps the planner on a
 * tenant_id-leading index, and gives a wrong query an empty result in
 * development instead of a policy error in production.
 *
 * Three properties, in order of how much they matter:
 *
 *   1. Every method takes a `TenantTx` and nothing else. There is no
 *      overload that accepts a pool, a Kysely instance, or a plain
 *      transaction, so a repository call outside `withTenant` does not
 *      compile — and, because the handle is also checked at runtime against
 *      the registry in transaction.ts, a cast does not get round it either.
 *
 *   2. The tenant predicate is applied by the base class, from the context.
 *      It is not a parameter, so it cannot be passed the wrong value.
 *
 *   3. There is no delete. Rule 4 forbids hard deletes of financial and
 *      operational records, DELETE is granted to no role by default
 *      (FND-005), and a base class that offered `deleteById` would be an
 *      invitation to grant it. Deactivation is a status update.
 *
 * ADR-0013:127 notes that most repository code in the ERP will be copied
 * from this class, which is why it is this heavily commented.
 */

export abstract class BaseRepository<TB extends TenantTableName> {
  protected constructor(protected readonly table: TB) {}

  /** The tenant this unit of work belongs to. Context only, never an argument. */
  protected get tenantId(): string {
    return TenantContext.require().tenantId
  }

  /**
   * The acting user, for created_by / updated_by.
   *
   * Null during tenant provisioning, where no user exists yet. Every table
   * except `users` declares these columns NOT NULL, so a null here surfaces
   * as a constraint violation rather than an anonymous row — which is the
   * intended behaviour (rule 9: every mutation has an author).
   */
  protected get actingUserId(): string | null {
    return TenantContext.require().userId
  }

  /**
   * `tenant_id = <context tenant>` as a SQL expression.
   *
   * Written as an expression rather than `.where('tenant_id', ...)` because
   * the table name is a generic parameter here, and Kysely cannot prove a
   * column belongs to a table it only knows as `TB`. The predicate is a
   * literal in this file — the tenant value is bound, not interpolated.
   */
  protected tenantPredicate(): ReturnType<typeof sql<SqlBool>> {
    return sql<SqlBool>`tenant_id = ${this.tenantId}::uuid`
  }

  /**
   * SELECT from this table with the tenant predicate already applied.
   *
   * Subclasses add columns, joins and pagination on top. They do not add the
   * tenant filter, and they do not need to remember to.
   */
  protected scopedSelect(tx: TenantTx): SelectQueryBuilder<Database, TB, object> {
    assertIssuedTenantTx(tx)
    /*
     * The cast widens Kysely's table-specific builder to the general
     * `SelectQueryBuilder<Database, TB, object>`. With TB unresolved,
     * `selectFrom` returns a union of per-table builder shapes whose `where`
     * overloads TypeScript will not reconcile; naming the general type is
     * what makes a generic repository base possible at all. It loses no
     * safety at the call site, where TB is a literal table name.
     */
    const query = tx.selectFrom(this.table) as unknown as SelectQueryBuilder<Database, TB, object>
    return query.where(this.tenantPredicate())
  }

  /**
   * INSERT with tenant_id and authorship stamped by the base class.
   *
   * `tenant_id` is not in the caller's value type, so a repository cannot
   * supply one even by accident, and `req.body.tenantId` has nowhere to go.
   * RLS's WITH CHECK is the backstop if this is ever bypassed.
   */
  protected scopedInsert(
    tx: TenantTx,
    values: Omit<InsertObject<Database, TB>, 'tenant_id' | 'created_by' | 'updated_by'>,
  ) {
    assertIssuedTenantTx(tx)

    const actor = this.actingUserId
    /*
     * One cast, here, in the one place that is allowed to know that every
     * tenant-owned table carries these four columns. TB is a type parameter,
     * so TypeScript cannot see the columns; the schema test in
     * database/tests/schema.spec.ts is what proves the assumption holds for
     * every table in the live database.
     */
    const row = {
      ...values,
      tenant_id: this.tenantId,
      created_by: actor,
      updated_by: actor,
    } as InsertObject<Database, TB>

    return tx.insertInto(this.table).values(row)
  }

  /**
   * UPDATE with the tenant predicate and the optimistic-lock compare applied.
   *
   * `expectedVersion` is not optional. An update that does not say which
   * version it read is a lost-update waiting for two users to open the same
   * record, and making the argument optional means every caller in a hurry
   * omits it. Callers assert that exactly one row was affected; zero means
   * someone else got there first.
   *
   * `updated_at` is left alone deliberately — the `set_updated_at` trigger
   * from migration 001 owns it, so no caller can backdate a row by passing a
   * timestamp (rule 13).
   */
  protected scopedUpdate(
    tx: TenantTx,
    values: Omit<UpdateObject<Database, TB>, 'tenant_id' | 'created_by' | 'created_at' | 'version'>,
    where: { id: string; expectedVersion: number },
  ): UpdateQueryBuilder<Database, TB, TB, object> {
    assertIssuedTenantTx(tx)

    const patch = {
      ...values,
      updated_by: this.actingUserId,
      version: where.expectedVersion + 1,
    } as UpdateObject<Database, TB>

    // Same widening as scopedSelect, for the same reason.
    const query = tx.updateTable(this.table) as unknown as UpdateQueryBuilder<
      Database,
      TB,
      TB,
      object
    >

    return query
      .set(patch)
      .where(this.tenantPredicate())
      .where(sql<SqlBool>`id = ${where.id}::uuid`)
      .where(sql<SqlBool>`version = ${where.expectedVersion}`)
  }

  /*
   * No scopedDelete. Rule 4: hard delete is forbidden for any operational or
   * financial record, and no role holds the DELETE privilege by default.
   * A record that is finished is given a terminal status.
   */
}
