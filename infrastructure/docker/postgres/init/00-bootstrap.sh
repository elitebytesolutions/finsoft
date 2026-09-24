#!/bin/bash
# FinSoft cluster bootstrap. FND-005.
#
# Runs once, on an empty data directory, as the container's bootstrap
# superuser. It creates the role separation that ADR-0004 depends on and then
# gets out of the way — no application code ever connects as POSTGRES_USER.
#
# This is a .sh rather than a .sql because the database name and the role
# passwords arrive as environment variables. Values are passed to psql as
# variables and quoted by psql itself, never interpolated into SQL text.
#
# The same script initialises the development and test clusters; only
# FINSOFT_DB differs.

set -euo pipefail

: "${FINSOFT_DB:?FINSOFT_DB is required}"
: "${FINSOFT_APP_PASSWORD:?FINSOFT_APP_PASSWORD is required}"
: "${FINSOFT_MIGRATION_PASSWORD:?FINSOFT_MIGRATION_PASSWORD is required}"
: "${FINSOFT_READONLY_PASSWORD:?FINSOFT_READONLY_PASSWORD is required}"

echo "FinSoft bootstrap: creating roles and database '${FINSOFT_DB}'"

# ---------------------------------------------------------------------------
# Roles
#
# Exactly three. finsoft_breakglass is NOT created locally: it is a production
# emergency superuser, NON_NEGOTIABLES rule 21 scopes agents to local and CI,
# and a local superuser would muddy database/tests/roles.spec.ts, which
# asserts the migration role's bypass is the only one in the cluster.
#
# Naming note: finsoft_app and finsoft_migration are the identifiers ADR-0004
# writes SQL for. readonly_support is rule 21's name (LEVEL 0). This leaves
# the prefixes inconsistent and contradicts INFRASTRUCTURE.md:152, which says
# finsoft_readonly — reported, not silently reconciled.
# ---------------------------------------------------------------------------
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v app_password="$FINSOFT_APP_PASSWORD" \
  -v migration_password="$FINSOFT_MIGRATION_PASSWORD" \
  -v readonly_password="$FINSOFT_READONLY_PASSWORD" <<-'SQL'
	-- DDL and BYPASSRLS. Owns every table it creates, which is what makes
	-- FORCE ROW LEVEL SECURITY meaningful for the app role (ADR-0004:59).
	CREATE ROLE finsoft_migration LOGIN BYPASSRLS PASSWORD :'migration_password';

	-- The running API and worker. No BYPASSRLS, no SUPERUSER, and not the
	-- owner of anything. ADR-0004:57 calls this "the difference between RLS
	-- being a control and RLS being decoration".
	CREATE ROLE finsoft_app LOGIN PASSWORD :'app_password';

	-- Support reads. Also subject to RLS: access to a tenant is granted by
	-- setting the tenant, never by bypassing the policy (ADR-0004:61).
	CREATE ROLE readonly_support LOGIN PASSWORD :'readonly_password';
SQL

# ---------------------------------------------------------------------------
# Database, owned by the migration role
#
# TEMPLATE template0 with the locale spelled out, so the application database
# carries the intended collation even if template1 is ever altered.
# ---------------------------------------------------------------------------
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v db_name="$FINSOFT_DB" <<-'SQL'
	CREATE DATABASE :"db_name"
	  OWNER           finsoft_migration
	  TEMPLATE        template0
	  ENCODING        'UTF8'
	  LOCALE_PROVIDER builtin
	  BUILTIN_LOCALE  'C.UTF-8';
SQL

# ---------------------------------------------------------------------------
# Privileges inside the application database
# ---------------------------------------------------------------------------
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$FINSOFT_DB" \
  -v db_name="$FINSOFT_DB" <<-'SQL'
	REVOKE ALL ON DATABASE :"db_name" FROM PUBLIC;
	GRANT CONNECT ON DATABASE :"db_name" TO finsoft_app, readonly_support;

	-- The migration role owns the schema; the app role may use it but not
	-- create in it. An application that cannot create a table cannot quietly
	-- add one that escapes review, RLS or the schema tests.
	ALTER SCHEMA public OWNER TO finsoft_migration;
	REVOKE ALL ON SCHEMA public FROM PUBLIC;
	GRANT USAGE ON SCHEMA public TO finsoft_app, readonly_support;

	-- Default privileges on what finsoft_migration creates from here on.
	-- Without these, every migration has to remember a GRANT, and the one
	-- that forgets fails at runtime rather than at review.
	--
	-- DELETE is deliberately NOT granted by default. NON_NEGOTIABLES rule 4
	-- forbids hard deletes of financial and operational records, so a
	-- migration that needs DELETE on a specific table grants it explicitly
	-- and justifies it in review. This is narrower than INFRASTRUCTURE
	-- §5's shorthand "CRUD"; the LEVEL 0 rule wins, and widening later is
	-- one line where narrowing later is an audit.
	ALTER DEFAULT PRIVILEGES FOR ROLE finsoft_migration IN SCHEMA public
	  GRANT SELECT, INSERT, UPDATE ON TABLES TO finsoft_app;
	ALTER DEFAULT PRIVILEGES FOR ROLE finsoft_migration IN SCHEMA public
	  GRANT SELECT ON TABLES TO readonly_support;
	ALTER DEFAULT PRIVILEGES FOR ROLE finsoft_migration IN SCHEMA public
	  GRANT USAGE, SELECT ON SEQUENCES TO finsoft_app;
	ALTER DEFAULT PRIVILEGES FOR ROLE finsoft_migration IN SCHEMA public
	  GRANT SELECT ON SEQUENCES TO readonly_support;
SQL

# No cluster default is set for app.tenant_id, deliberately. ADR-0004:77
# depends on current_setting('app.tenant_id') RAISING when it is unset:
# "This is the desired failure mode: loud, not permissive." A default would
# turn a hard error into silent cross-tenant visibility.

echo "FinSoft bootstrap: done"
