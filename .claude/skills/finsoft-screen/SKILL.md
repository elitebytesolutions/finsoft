---
name: finsoft-screen
description: Build or change a screen in apps/web (Next.js App Router) for the FinSoft ERP. Use when adding a page or route, changing an existing screen's layout, adding a table, form, filter bar, drawer or modal, or wiring a screen to data. Covers the page-document-first workflow, the Financial UI Kit, required states, and the rules a financial UI must not break.
---

# Building a screen in apps/web

## 1. Read the page document first

Almost every screen already has a specification: `docs/design-system/pages/<slug>/README.md`.
There are 69 of them. They fix the route, the archetype, the permission, the anatomy, the
columns with their alignment and format, the status-tone mapping and the empty/error states.

**If a page document exists, it wins over your judgement about layout.** If it is missing,
write it before the code — `docs/design-system/pages/README.md` has the template — or say
plainly that you are building without one.

Then read, in this order as needed:
`docs/design-system/03-patterns.md` (archetypes A–H) · `02-components.md` (what the kit has) ·
`04-states.md` (loading, empty, error, denied) · `01-foundations.md` (tokens).

## 2. The boundary

```
apps/web --> packages/ui, shared-types, validation     (no business rules)
```

`apps/web` composes, fetches and holds page-local state. It does not decide numbers.
No totalling a ledger, no computing tax, no deriving a stock balance, no building a
journal line. If a figure needs calculating, it is calculated server-side and sent.

`packages/ui` holds the kit. Feature code **imports** components; it never copies, forks
or re-styles one. Need a component the kit lacks? Ask the design-system agent to add it
there. A one-off `<div className="my-custom-table">` in a route folder is the drift this
rule exists to prevent.

## 3. Structure of a route

```
apps/web/app/<segment>/page.tsx   thin: guard + screen + props from context
apps/web/src/screens/<name>.tsx   the screen component
packages/ui/src/...               anything reusable
```

Route segments stay thin. Put the screen in `src/screens/` so it is testable without the
router. Wrap in `<Guard module="...">` using the module name from the page document.

`Guard` is a UI affordance only — it hides what a role may not open. It authorises nothing.
Real authorisation is server-side.

## 4. Tokens, never raw values

Every colour, space, radius, shadow and duration comes from `packages/ui/src/tokens/`.
A raw hex, a px shadow or a font size in a feature file is a design-system violation
(`docs/design-system/08-governance.md`).

Known debt, so you are not surprised: `packages/ui/src/styles/kit.css` is the prototype's
stylesheet moved verbatim and is **full** of raw hex. It is grandfathered and tracked.
Do not treat it as licence to add more, and do not "fix" it opportunistically — a
tokenisation pass over it is its own task with its own parity run.

## 5. Rules a financial UI does not get to break

From `docs/NON_NEGOTIABLES.md` and `01-foundations.md` section 1.3:

- **Debit is not "good" and credit is not "bad".** `--money-debit` / `--money-credit` are
  fixed meanings. Never reuse them for success/failure, and never use success/failure tones
  for Dr/Cr. This is the single most common financial-UI mistake.
- **Money is right-aligned, tabular-nums, always.** Every cell, KPI, total and numeric input.
- **Zero renders as an em dash**, not `0.00`, in a ledger column.
- **A number never animates.** No count-ups, no slide-ins, no motion on a figure.
- **One status maps to one tone, product-wide.** The mapping is fixed per page in its document.
- **A posted record is immutable in the UI too.** Offer reversal, never an edit affordance.
- **Never render a computed-in-the-browser figure as if it were posted.** Until the API and
  the kernels land, everything from `apps/web/src/mocks/` is demo state. Nothing there has
  touched a ledger.

## 6. States are not optional

Every data surface handles four: loading (skeleton, not a spinner over stale numbers),
empty (explain what would fill it), error (what failed and what to do), denied (the role
lacks permission). `docs/design-system/04-states.md` specifies each. "It looks right with
data" is not done.

## 7. Before you say it is done

```bash
npm run typecheck
npm test
npm run parity      # if you touched anything a prototype screen also renders
```

Plus: keyboard reachable, focus visible, labels on inputs, `aria-label` on any icon that
carries meaning alone, works at the responsive breakpoints in `07-responsive.md`, and you
stayed inside your delivery brief's ALLOWED paths.

Report as `DONE · FILES · TESTS · DECISIONS · BLOCKED · OBSERVED`.
