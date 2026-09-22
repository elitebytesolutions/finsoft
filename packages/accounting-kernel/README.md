# @finsoft/accounting-kernel

The posting engine. The single implementation of accounting behaviour in the system — no module invents journal rows. Modules raise a typed FinancialEvent; this package is the only code that builds journal lines (ADR-0005).

**May import:** `packages/database`, `packages/validation`, `packages/shared-types` — and nothing else. It knows nothing about feature modules, HTTP or UI, and has no network.

Empty until Wave 2. Enforced by dependency-cruiser in CI (FND-002).
