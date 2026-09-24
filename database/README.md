# database/

Schema, reference data and schema-level tests. The schema is the compliance
surface for the LEVEL 0 invariants, so everything here is hand-written SQL a
human reviews — never generated (ADR-0013).

| | |
|---|---|
| `migrations/` | Numbered, forward-only, **immutable once applied**. One transaction per file. Rollback is a new forward migration, never an edit and never a `down`. |
| `seeds/` | Reference data: chart-of-accounts templates, tax codes. |
| `fixtures/` | Test data. |
| `tests/` | Schema, constraint, grant and RLS tests — `schema.spec.ts`, `rls.spec.ts`, `roles.spec.ts`. |

`migrations/**` requires Database Guardian review (CODEOWNERS). No other agent
changes database structure.
