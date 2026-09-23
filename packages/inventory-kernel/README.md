# @finsoft/inventory-kernel

The movement ledger and valuation. No module writes `stock_movements` directly. FEFO governs which batch is consumed; weighted average governs what it cost (ADR-0007, ADR-0008).

**May import:** `packages/database`, `packages/validation`, `packages/shared-types` — and nothing else. No network.

Empty until Wave 5. Enforced by dependency-cruiser in CI (FND-002).
