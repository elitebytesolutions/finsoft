-- 001_create_tenants.sql
--
-- The tenant registry. Every tenant-owned table in the system carries
-- tenant_id UUID NOT NULL REFERENCES tenants(id), so this is the root of the
-- tenancy model (ADR-0003).
--
-- This table is GLOBAL: it has no tenant_id of its own and no row level
-- security. ADR-0003 places global reference tables outside RLS, and
-- ADR-0004:77 requires that login and tenant provisioning — which have no
-- tenant context yet — operate only on global tables. A tenant cannot be
-- resolved from a JWT claim that does not exist until this table has been
-- read.
--
-- Flagged for the FND-007/008 isolation gate: the application role can
-- therefore SELECT every row of this table. That is intended (login needs
-- it) but it is the one place tenant metadata is visible across tenants, and
-- it deserves the Database Guardian's explicit sign-off rather than mine.

-- ---------------------------------------------------------------------------
-- Shared trigger function: keeps updated_at honest.
-- An updated_at column that the application must remember to set is a column
-- that will eventually be wrong.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION set_updated_at() IS
  'Sets updated_at to the server clock on UPDATE. Never trusts a client timestamp (rule 13).';

-- ---------------------------------------------------------------------------
-- tenants
-- ---------------------------------------------------------------------------
CREATE TABLE tenants (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Business identifier, stable and human-readable. Used in document number
  -- prefixes and support conversations.
  code           text        NOT NULL UNIQUE
                             CHECK (code ~ '^[A-Z][A-Z0-9_]{1,15}$'),

  name           text        NOT NULL CHECK (length(btrim(name)) > 0),
  legal_name     text,

  -- Pakistan tax identifiers. Nullable because a tenant is created before
  -- registration details are collected; format is validated in the domain
  -- layer where the rules are written down.
  ntn            text,
  strn           text,

  -- Lifecycle, not deletion. Rule 4 forbids hard deletes of operational
  -- records, so a tenant that stops trading is CLOSED and keeps its history.
  status         text        NOT NULL DEFAULT 'ACTIVE'
                             CHECK (status IN ('ACTIVE', 'SUSPENDED', 'CLOSED')),

  -- ADR-0011: PKR is the base currency and v1 rejects anything else. The
  -- CHECK makes that a schema fact rather than a convention, and widening it
  -- later will require a migration that someone has to review.
  base_currency  char(3)     NOT NULL DEFAULT 'PKR'
                             CHECK (base_currency = 'PKR'),

  -- Display timezone. Storage is always UTC (rule 13); this is what the UI
  -- renders in and what appears on exports.
  timezone       text        NOT NULL DEFAULT 'Asia/Karachi',

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE tenants IS
  'Tenant registry. Global: no tenant_id, no RLS (ADR-0003). Read by login and provisioning before a tenant context exists (ADR-0004:77).';
COMMENT ON COLUMN tenants.status IS
  'ACTIVE | SUSPENDED | CLOSED. Tenants are never deleted (rule 4).';
COMMENT ON COLUMN tenants.base_currency IS
  'PKR only in v1 (ADR-0011). Widening this requires a reviewed migration.';

CREATE TRIGGER tenants_set_updated_at
  BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Active tenants are the common lookup during login.
CREATE INDEX tenants_status_idx ON tenants (status) WHERE status = 'ACTIVE';

-- ---------------------------------------------------------------------------
-- Grants
--
-- The default privileges established when the cluster was bootstrapped
-- (FND-005) already grant SELECT, INSERT, UPDATE to finsoft_app and SELECT to
-- readonly_support on tables created by finsoft_migration. They are restated
-- here explicitly because this is the table every other table references, and
-- because a reader of this file should not have to know what the container
-- init script did.
--
-- DELETE is granted to nobody. Rule 4.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON tenants TO finsoft_app;
GRANT SELECT                 ON tenants TO readonly_support;
