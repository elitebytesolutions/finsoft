import { withGlobal } from '@finsoft/database'
import { rawOn } from '@finsoft/database/testing'

/*
 * Catalog queries shared by schema.spec.ts, rls.spec.ts and roles.spec.ts.
 *
 * Two deliberate choices here.
 *
 * Everything reads `pg_catalog`, never `information_schema`. The views in
 * information_schema are filtered by the privileges of the querying role, so
 * a future table created without a GRANT would be invisible to finsoft_app —
 * and that table is precisely the one a schema test exists to catch. A test
 * that cannot see the thing it is meant to fail on is worse than no test.
 *
 * Everything runs through `withGlobal` as finsoft_app. The assertions are
 * about the schema, and proving that the restricted application role can
 * establish them without elevation is part of the point.
 */

export interface TableRow {
  table_name: string
  rls_enabled: boolean
  rls_forced: boolean
  policy_count: string
  has_primary_key: boolean
}

export function tables(): Promise<TableRow[]> {
  return withGlobal((tx) =>
    rawOn<TableRow>(
      tx,
      `select c.relname                           as table_name,
              c.relrowsecurity                    as rls_enabled,
              c.relforcerowsecurity               as rls_forced,
              (select count(*) from pg_policy p
                where p.polrelid = c.oid)::text   as policy_count,
              exists (select 1 from pg_index i
                       where i.indrelid = c.oid and i.indisprimary)
                                                  as has_primary_key
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relkind = 'r'
        order by c.relname`,
    ),
  )
}

export interface ColumnRow {
  table_name: string
  column_name: string
  data_type: string
  not_null: boolean
  has_default: boolean
}

export function columns(): Promise<ColumnRow[]> {
  return withGlobal((tx) =>
    rawOn<ColumnRow>(
      tx,
      `select c.relname                                  as table_name,
              a.attname                                  as column_name,
              format_type(a.atttypid, a.atttypmod)       as data_type,
              a.attnotnull                               as not_null,
              a.atthasdef                                as has_default
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         join pg_attribute a on a.attrelid = c.oid
        where n.nspname = 'public'
          and c.relkind = 'r'
          and a.attnum > 0
          and not a.attisdropped
        order by c.relname, a.attnum`,
    ),
  )
}

export interface IndexRow {
  table_name: string
  index_name: string
  is_unique: boolean
  is_primary: boolean
  /** NULL when the leading index column is an expression rather than a column. */
  first_column: string | null
  definition: string
}

export function indexes(): Promise<IndexRow[]> {
  return withGlobal((tx) =>
    rawOn<IndexRow>(
      tx,
      `select c.relname     as table_name,
              i.relname     as index_name,
              ix.indisunique as is_unique,
              ix.indisprimary as is_primary,
              (select a.attname
                 from pg_attribute a
                where a.attrelid = c.oid and a.attnum = ix.indkey[0]) as first_column,
              pg_get_indexdef(ix.indexrelid) as definition
         from pg_index ix
         join pg_class c on c.oid = ix.indrelid
         join pg_class i on i.oid = ix.indexrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
        order by c.relname, i.relname`,
    ),
  )
}

export interface ConstraintRow {
  constraint_name: string
  table_name: string
  referenced_table: string | null
  contype: string
  /** pg_constraint.confdeltype: a=NO ACTION r=RESTRICT c=CASCADE n=SET NULL d=SET DEFAULT */
  on_delete: string | null
  definition: string
}

export function constraints(): Promise<ConstraintRow[]> {
  return withGlobal((tx) =>
    rawOn<ConstraintRow>(
      tx,
      `select con.conname                    as constraint_name,
              c.relname                      as table_name,
              rc.relname                     as referenced_table,
              con.contype::text              as contype,
              nullif(con.confdeltype, '')::text as on_delete,
              pg_get_constraintdef(con.oid)  as definition
         from pg_constraint con
         join pg_class c on c.oid = con.conrelid
         join pg_namespace n on n.oid = c.relnamespace
         left join pg_class rc on rc.oid = con.confrelid
        where n.nspname = 'public'
        order by c.relname, con.conname`,
    ),
  )
}

export interface PolicyRow {
  table_name: string
  policy_name: string
  command: string
  permissive: string
  using_expression: string | null
  with_check_expression: string | null
  /** ADR-0023: `{-}` (rendered as the literal role name "public" by regrole) means PUBLIC. */
  roles: string[]
}

export function policies(): Promise<PolicyRow[]> {
  return withGlobal((tx) =>
    rawOn<PolicyRow>(
      tx,
      `select c.relname                                as table_name,
              p.polname                                as policy_name,
              p.polcmd::text                           as command,
              case when p.polpermissive then 'PERMISSIVE' else 'RESTRICTIVE' end as permissive,
              pg_get_expr(p.polqual, p.polrelid)       as using_expression,
              pg_get_expr(p.polwithcheck, p.polrelid)  as with_check_expression,
              p.polroles::regrole[]::text[]            as roles
         from pg_policy p
         join pg_class c on c.oid = p.polrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
        order by c.relname, p.polname`,
    ),
  )
}

export interface ColumnPrivilegeRow {
  table_name: string
  column_name: string
  grantee: string
  privilege: string
}

/**
 * Column-level grants, straight from `pg_attribute.attacl` via `aclexplode`
 * — NOT `information_schema.column_privileges`, which is privilege-filtered
 * by the querying role and would silently show only what `finsoft_app`
 * itself can see (this file's own header rule). `attacl IS NOT NULL` only:
 * a column with no column-level ACL of its own inherits the table-level
 * grant, which `roles.spec.ts`'s `has_table_privilege`/`has_column_privilege`
 * checks already cover.
 */
export function columnPrivileges(): Promise<ColumnPrivilegeRow[]> {
  return withGlobal((tx) =>
    rawOn<ColumnPrivilegeRow>(
      tx,
      `select c.relname as table_name,
              a.attname as column_name,
              (aclexplode(a.attacl)).grantee::regrole::text as grantee,
              (aclexplode(a.attacl)).privilege_type as privilege
         from pg_attribute a
         join pg_class c on c.oid = a.attrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and a.attnum > 0
          and not a.attisdropped
          and a.attacl is not null
        order by c.relname, a.attname, grantee, privilege`,
    ),
  )
}

export interface TableAclRow {
  table_name: string
  grantee: string
  privilege: string
}

/**
 * D2 (security/database re-review 2026-09-27): table-LEVEL grants, from
 * `pg_class.relacl` via `aclexplode` — the column-privilege checks in
 * `columnPrivileges()` above see only `pg_attribute.attacl` and would miss
 * a role that somehow acquired a TABLE-level grant instead (which implies
 * every column, defeating an exact-column-set assertion silently).
 */
export function tableAcl(): Promise<TableAclRow[]> {
  return withGlobal((tx) =>
    rawOn<TableAclRow>(
      tx,
      `select c.relname as table_name,
              (aclexplode(c.relacl)).grantee::regrole::text as grantee,
              (aclexplode(c.relacl)).privilege_type as privilege
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relkind = 'r'
          and c.relacl is not null
        order by c.relname, grantee, privilege`,
    ),
  )
}

export interface SchemaRow {
  schema_name: string
  owner: string
}

/** Non-system schemas. ADR-0023: "the non-system schema set is exactly {public, auth_lookup}". */
export function schemas(): Promise<SchemaRow[]> {
  return withGlobal((tx) =>
    rawOn<SchemaRow>(
      tx,
      `select nspname as schema_name, nspowner::regrole::text as owner
         from pg_namespace
        where nspname not like 'pg\\_%' and nspname <> 'information_schema'
        order by nspname`,
    ),
  )
}

export interface RoleRow {
  role_name: string
  is_superuser: boolean
  bypasses_rls: boolean
  can_login: boolean
}

export function roles(): Promise<RoleRow[]> {
  return withGlobal((tx) =>
    rawOn<RoleRow>(
      tx,
      `select rolname      as role_name,
              rolsuper     as is_superuser,
              rolbypassrls as bypasses_rls,
              rolcanlogin  as can_login
         from pg_roles
        where rolname not like 'pg\\_%'
        order by rolname`,
    ),
  )
}
