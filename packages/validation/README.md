# @finsoft/validation

Shared zod schemas and the money/date/decimal primitives. The only place `decimal.js` may be imported; exports the frozen configured constructor and the branded `Money`, `UnitCost` and `Quantity` types (ADR-0011, ADR-0014).

**May import:** `packages/shared-types`.

Empty until FND-004. Enforced by dependency-cruiser in CI (FND-002).
