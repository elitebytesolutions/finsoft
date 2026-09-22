# modules/

Feature modules. Each one is added by the wave that needs it — this directory
stays empty until Wave 3, because Wave 0 builds no business features.

Every module has the same four layers, with dependencies pointing strictly
inward:

```
api  →  application  →  domain
              infrastructure  →  domain
```

`domain/` is pure TypeScript: no NestJS, no ORM, no HTTP, no Kysely.

Modules never import each other's internals and never write to each other's
tables — cross-module traffic goes through a published application-layer
interface or a domain event. Modules never construct journal lines
(`postingEngine.post`) and never write `stock_movements`
(`inventoryKernel.postMovement`). Enforced by dependency-cruiser in CI.
