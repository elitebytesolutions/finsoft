# Governance

## 1. Ownership

| Thing | Owner | Changed by |
|---|---|---|
| Tokens (`01-foundations`) | `design-system` agent | PR + design-system review |
| Component contracts (`02-components`) | `design-system` agent | PR + design-system review |
| Page archetypes (`03-patterns`) | `design-system` agent + Product Owner | PR + both approvals |
| A page document (`pages/<slug>/`) | The module owner for that page | PR + design-system review |
| Display of accounting facts (Dr/Cr, immutability, period lock, tenant) | `accounting-guardian` | **Not changeable here** — Level 0 |

`.claude/agents/design-system.md` is the agent that holds this system. Feature agents **request**
components from it; they do not add shared components themselves.

## 2. Where the code lives

```
packages/ui/
  src/tokens/          <- 01-foundations, generated to CSS variables + TS constants
  src/primitives/      <- 02-components sections B, C
  src/data/            <- section D (DataTable, LedgerTable, TreeTable, Kpi, charts)
  src/overlays/        <- section E
  src/states/          <- section F
  src/financial/       <- section G (DrCrAmount, PeriodSelector, IdempotencyGuard, AuditStamp)
  src/patterns/        <- section 03 archetype scaffolds
  src/format/          <- 05-content-and-formatting
apps/web/app/(routes)/ <- pages only: composition, data fetching, page-local state
```

Boundary rule from [CLAUDE.md](../../CLAUDE.md): `apps/web -> packages/ui, shared-types, validation`.
`packages/ui` contains **no business rules** — no posting logic, no tax calculation, no stock maths.
It may know that debits and credits are different things; it may not know how to compute one.
`dependency-cruiser` enforces the direction in CI.

## 3. Adding or changing a component

1. Check this catalogue and the page documents for an existing component that fits.
2. If none fits, open a request with: the page(s) that need it, the archetype it serves, the states
   it must carry, and the accessibility contract.
3. The `design-system` agent either extends an existing component (preferred) or adds a new one.
4. A new component is not done until it has: tokens only (no raw values), all seven states, keyboard
   and screen-reader behaviour, a story, and a page document referencing it.
5. Deprecations keep the old export for one wave with a console warning and a note here.

## 4. Adding a page

1. Create `docs/design-system/pages/<slug>/README.md` from the template in
   [pages/README.md](pages/README.md).
2. Name the archetype. Record only deviations from it.
3. List the columns with their alignment, format and priority; the actions with their permission and
   confirmation; the states with their copy.
4. Get it reviewed **before** implementation. A page contract that appears after the code is not a
   contract, it is a description.

## 5. Drift review — the PR checklist

A UI PR is rejected if any of these is true:

- [ ] A raw hex, px shadow, or font size appears outside `packages/ui/src/tokens`.
- [ ] A one-off table, button, badge, modal or empty state is defined in a feature file.
- [ ] A money value is centred, left-aligned, unsigned-but-negative, or rendered from a JS `number`.
- [ ] Debit and credit share a column on an accounting surface.
- [ ] A posted record exposes an edit affordance, disabled or not.
- [ ] A post, reverse, void, delete or period-close happens without a `ConfirmDialog`.
- [ ] A submit path lacks an idempotency key.
- [ ] Any of loading / empty / filtered-empty / error / permission / period-locked is unhandled.
- [ ] A list, export or print omits company and period.
- [ ] A screen cannot be completed with the keyboard, or axe-core reports a violation.
- [ ] The page's document does not exist, or the screen does not match it.

## 6. Relationship to the prototype

`ui-prototype/` is **reference, not source**. It is frozen input: it shows intended layout, wording,
column sets and interaction. It is not imported, not migrated, and not a style guide for code
quality. Where it conflicts with this system, this system wins and the page document records the
deviation under *Deviations from the prototype*.

Known prototype-wide deviations already decided here:

| Prototype | Production |
|---|---|
| Page-scoped CSS namespaces (`al-`, `vg-`, `coa2-`, `chq-`…) | Shared kit components + tokens |
| Table text at 9.8px, badges at 8.5px | 12px / 10px floors |
| ~30 ad-hoc max-width breakpoints | Six named breakpoints |
| `localStorage` store, client-computed balances | Server is the source of every figure |
| Role switcher in the top bar | Real authentication and RBAC |
| Disabled buttons titled "Available in the connected backend edition" | Real permission reasons |
