-- 006_pre_tenant_refresh_lookup.sql
--
-- The refresh-path pre-tenant resolver. ADR-0023 §2, D-W1-004.
--
-- A refresh token arrives as a bare 256-bit value in a cookie, with no tenant
-- context. `refresh_tokens` is tenant-owned, RLS ENABLE+FORCE, and
-- current_setting('app.tenant_id') has no missing_ok — so an unauthenticated
-- read RAISES rather than returning zero rows (ADR-0004:77). This migration
-- is the one, narrow, reviewed exception: a SECURITY DEFINER function, owned
-- by a role with NO BYPASSRLS, crossing the tenant boundary through a named
-- policy rather than a role attribute, returning (tenant_id, token_id) and
-- writing nothing.
--
-- Every statement below is normative in ADR-0023 §2's own words: five
-- statements in an earlier draft were wrong, four of which did not raise —
-- they reported success and did nothing, which is worse than an error that
-- aborts. Do not "simplify" this file; read the ADR before touching it.
--
-- ---------------------------------------------------------------------------
-- The role this migration depends on lives OUTSIDE the migration chain
--
-- `finsoft_migration` has no CREATEROLE (measured: `CREATE ROLE` raises
-- "permission denied to create role"), so `finsoft_refresh` cannot be created
-- here. It is created once, by `00-bootstrap.sh`, on an empty data directory.
-- Every existing cluster therefore needs it provisioned out of band or
-- recreated with `docker compose down -v`. The guard below fails loudly and
-- readably instead of failing at the first GRANT with a cryptic "role does
-- not exist".
-- ---------------------------------------------------------------------------
DO $g$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'finsoft_refresh') THEN
    RAISE EXCEPTION 'finsoft_refresh is missing. It is created by 00-bootstrap.sh, '
      'not by a migration (finsoft_migration has no CREATEROLE). Provision it, or '
      'recreate the cluster with docker compose down -v.';
  END IF;
END $g$;

-- The column-scoped read the resolver's body needs and nothing more.
-- token_hash is required because the function filters on it — revoke it and
-- the body raises 42501 ("permission denied for table", not "for column").
-- id is required because it is in the select list.
GRANT SELECT (tenant_id, id, token_hash) ON refresh_tokens TO finsoft_refresh;

-- The narrow policy that crosses the tenant boundary. USING (true) IS
-- LOAD-BEARING AS A CONSTANT: tenant_isolation on refresh_tokens has
-- polroles = {-} (PUBLIC), so it applies to finsoft_refresh too, and its
-- qual calls current_setting('app.tenant_id') with no missing_ok at a moment
-- when the tenant is by definition unset. The two PERMISSIVE policies are
-- OR'd, and the constant `true` lets the planner fold the disjunction away
-- entirely rather than evaluate the other policy's raising qual. A narrower
-- qual only works by cost-based OR short-circuit ordering, which is not
-- guaranteed — any future narrowing turns /auth/refresh into an intermittent
-- 42704 in production. Scoping tenant_isolation itself (TO finsoft_app,
-- readonly_support) is unavailable because migration 005 is released.
CREATE POLICY refresh_lookup ON refresh_tokens FOR SELECT TO finsoft_refresh USING (true);

CREATE SCHEMA auth_lookup;
REVOKE ALL   ON SCHEMA auth_lookup FROM PUBLIC;
GRANT  USAGE ON SCHEMA auth_lookup TO finsoft_app;
GRANT  USAGE ON SCHEMA public      TO finsoft_refresh;

-- TRANSIENT. The owner needs CREATE to create its own function; it is
-- revoked below, so the end state is an owner that owns nothing and can
-- create nothing. Without this, CREATE FUNCTION raises "permission denied
-- for schema auth_lookup": CREATE SCHEMA without AUTHORIZATION owns the
-- schema to finsoft_migration and grants the new role nothing.
GRANT USAGE, CREATE ON SCHEMA auth_lookup TO finsoft_refresh;

SET ROLE finsoft_refresh;                        -- OWNERSHIP. Not AUTHORIZATION.

  -- THE TWO FORBIDDEN REPAIRS, named because the next person to hit a
  -- permission error will not read the ADR. Faced with "permission denied
  -- for schema auth_lookup", there are two tempting fixes and both are the
  -- design this migration exists to prevent:
  --   1. Drop SET ROLE — the function is then owned by finsoft_migration,
  --      which has BYPASSRLS, and every statement in the body runs with
  --      unrestricted cross-tenant reach.
  --   2. Add AUTHORIZATION finsoft_refresh to CREATE SCHEMA — the definer's
  --      owner then holds permanent CREATE on the schema, contradicting the
  --      least-privilege end state.
  -- The correct repair is the transient grant above.

  CREATE FUNCTION auth_lookup.resolve_refresh(p_token_hash text)
  RETURNS TABLE (tenant_id uuid, token_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER ROWS 1
  SET search_path = pg_catalog, pg_temp AS $fn$
    SELECT t.tenant_id, t.id FROM public.refresh_tokens t WHERE t.token_hash = p_token_hash
  $fn$;
  -- STABLE is not a planning hint: it mechanically forbids a write inside the
  -- body ("UPDATE is not allowed in a non-volatile function"). It is NOT what
  -- prevents inlining — PostgreSQL never inlines a SECURITY DEFINER SQL
  -- function regardless of volatility. ROWS 1 corrects the default
  -- set-returning estimate of 1000 against a function that returns at most
  -- one row by a unique index. LEAKPROOF stays false (the default) so the
  -- body can never be pushed below an RLS qual.
  -- search_path = pg_catalog, pg_temp, with public DROPPED and every
  -- relation schema-qualified: the body resolves public.refresh_tokens
  -- explicitly rather than trusting an implicit path a later migration
  -- could poison.

  -- INSIDE the SET ROLE block. Outside it, issued as finsoft_migration,
  -- these are no-ops that report success — the function is owned by
  -- finsoft_refresh and INHERIT FALSE deliberately withholds the owner's
  -- grant option. Measured verbatim in the ADR: "no privileges could be
  -- revoked" / "no privileges were granted", both WARNING, both silent
  -- success under ON_ERROR_STOP.
  REVOKE EXECUTE ON FUNCTION auth_lookup.resolve_refresh(text) FROM PUBLIC;
  GRANT  EXECUTE ON FUNCTION auth_lookup.resolve_refresh(text) TO finsoft_app;

  -- Schema-less and FOR ROLE the creating role. The IN SCHEMA auth_lookup
  -- form records zero rows in pg_default_acl (it is additive to the
  -- built-in default, never subtractive of the implicit PUBLIC grant), and
  -- FOR ROLE defaults to the issuer — every function here is created by
  -- finsoft_refresh under SET ROLE, not by finsoft_migration.
  ALTER DEFAULT PRIVILEGES FOR ROLE finsoft_refresh REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

  -- COMMENT requires ownership (or superuser). finsoft_migration owns
  -- nothing here — INHERIT FALSE withholds even that passively — so this
  -- must run inside the SET ROLE block, same as the GRANT/REVOKE above.
  COMMENT ON FUNCTION auth_lookup.resolve_refresh(text) IS
    'ADR-0023 D-W1-004. The refresh path''s pre-tenant lookup. Returns (tenant_id, token_id) and '
    'no state — not used_at, not expires_at, not the family''s revoked_at. The resolver decides '
    'WHERE; the spend (migration 005''s atomic UPDATE, ADR-0022) decides WHETHER. There is a '
    'TOCTOU gap between resolving and spending, and it is harmless because the spend '
    're-evaluates everything atomically, under the tenant context, under RLS, under the row '
    'lock, under the transition triggers, additionally constrained by '
    'tenant_id = $resolved AND id = $resolved_id.';

RESET ROLE;

REVOKE CREATE ON SCHEMA auth_lookup FROM finsoft_refresh;   -- the transient grant, withdrawn

COMMENT ON SCHEMA auth_lookup IS
  'ADR-0023. Holds exactly one SECURITY DEFINER function and no relations of any kind. A '
  'tenant-owned table placed here would escape database/tests/catalog.ts, which filters '
  'nspname = ''public'' everywhere.';
