-- 003_restrict_schema_migrations.sql
--
-- The application role can rewrite the migration ledger. Close it.
--
-- schema_migrations records which migrations have been applied and their
-- checksums. It is the evidence ADR-0013 relies on to refuse an edited
-- migration: the runner compares each file against the checksum recorded
-- here. A role that can UPDATE that row can make an edited migration look
-- untouched, and the immutability guarantee becomes decoration.
--
-- Nothing had to be exploited for this to be wrong. It was inherited:
-- FND-005 set ALTER DEFAULT PRIVILEGES granting SELECT, INSERT, UPDATE on
-- finsoft_migration's future tables to finsoft_app, for ordinary application
-- tables. The migration runner then created schema_migrations as
-- finsoft_migration, and it picked up the same grants. Audited before writing
-- this: finsoft_app held exactly arw (INSERT, SELECT, UPDATE); there were no
-- PUBLIC grants, no role memberships and no ownership path.
--
-- SELECT is retained deliberately. The API's readiness probe reads this table
-- as finsoft_app to verify the schema is at the version the build requires,
-- and that is legitimate read-only use.
--
-- Note this migration must run on every environment, including ones where
-- 001 and 002 are already applied — which is why it is a new forward
-- migration rather than an edit to either (ADR-0013).

-- REVOKE ALL rather than naming INSERT and UPDATE. The audit found only those
-- two, but naming them would silently miss DELETE, TRUNCATE, REFERENCES or
-- TRIGGER if a future default-privilege change ever added one. Revoking
-- everything and granting back precisely what is needed cannot drift.
REVOKE ALL ON TABLE schema_migrations FROM finsoft_app;
REVOKE ALL ON TABLE schema_migrations FROM readonly_support;

-- Defensive: no PUBLIC grant exists today, and every role is a member of
-- PUBLIC, so a future one would reach every role at once.
REVOKE ALL ON TABLE schema_migrations FROM PUBLIC;

GRANT SELECT ON TABLE schema_migrations TO finsoft_app;
GRANT SELECT ON TABLE schema_migrations TO readonly_support;

COMMENT ON TABLE schema_migrations IS
  'Applied migrations and their checksums. Written only by finsoft_migration during deploy; read-only to every other role (003). Rewriting a checksum here would defeat ADR-0013 immutability.';

-- ---------------------------------------------------------------------------
-- This migration alone is not enough, and it is worth being precise about why.
--
-- The grants were not typed by anyone — ALTER DEFAULT PRIVILEGES applied them
-- automatically when the runner created the table. That default still stands
-- and cannot exclude a single table, so a cluster built from scratch recreates
-- schema_migrations and re-acquires write access before this file ever runs.
--
-- So the fix is in two places:
--   here          for every cluster where the table already exists;
--   in the runner for every cluster built from now on — it sets the grants
--                 immediately after CREATE TABLE, closing the window.
--
-- database/tests/roles.spec.ts asserts the outcome on every CI run. If either
-- control regresses, the build fails rather than the ledger quietly becoming
-- writable again.
-- ---------------------------------------------------------------------------
