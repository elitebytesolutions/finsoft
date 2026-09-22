# FinSoft Financial UI Kit — Design System

**Authority: Level 2** (see [CLAUDE.md](../../CLAUDE.md) — *Authority levels*).
Changing a token, a component contract or a page archetype needs Product Owner sign-off and a
`design-system` agent review. The **display invariants** quoted in this system (Dr/Cr treatment,
posted-record immutability affordances, period-lock states, tenant scoping of every list) are
restatements of **Level 0** rules from [docs/NON_NEGOTIABLES.md](../NON_NEGOTIABLES.md) and are
not editable here.

---

## What this is

The single visual and interaction contract for `apps/web` and `packages/ui`.
It exists so that sixty-eight screens built by different agents in different waves read as one
product, and so that a number on screen cannot be misread.

It is derived, screen by screen, from the approved prototype in
[`ui-prototype/`](../../ui-prototype) — the React prototype in `ui-prototype/src/` and the
reference frames in `ui-prototype/design/`. Where this document and the prototype disagree,
**this document wins** and the prototype is treated as an illustration, not a spec.

## The design rule that generates the others

> **The number is the interface.** Chrome may be pleasant; figures must be unambiguous.

Every rule below serves one of four goals:

1. **A figure is never ambiguous** — alignment, sign, currency, period and Dr/Cr are always explicit.
2. **A posted record never looks editable** — immutability is visible before it is enforced.
3. **A destructive or financial action is never one accidental click away** — post, reverse, close.
4. **The same job looks the same everywhere** — one archetype per job, not one design per screen.

## How to use it

| If you are… | Read |
|---|---|
| Building any screen | [00-principles](00-principles.md) → [03-patterns](03-patterns.md) → the page's own folder |
| Adding or changing a shared component | [02-components](02-components.md) + [08-governance](08-governance.md) |
| Picking a colour, size or spacing value | [01-foundations](01-foundations.md) — never invent a value |
| Handling empty / error / locked / no-permission | [04-states](04-states.md) |
| Formatting money, dates, quantities, doc numbers | [05-content-and-formatting](05-content-and-formatting.md) |
| Checking a PR for drift | [08-governance](08-governance.md) — the review checklist |

## Contents

| Document | Covers |
|---|---|
| [00-principles.md](00-principles.md) | The eight design principles and what they forbid |
| [01-foundations.md](01-foundations.md) | Colour, type, spacing, radius, elevation, motion, icons, layout grid, density |
| [02-components.md](02-components.md) | The Financial UI Kit — every shared component and its contract |
| [03-patterns.md](03-patterns.md) | The nine page archetypes every screen must be built from |
| [04-states.md](04-states.md) | Loading, empty, error, permission, period-locked, offline, posting |
| [05-content-and-formatting.md](05-content-and-formatting.md) | Money, quantity, date, document number, tone of voice, error copy |
| [06-accessibility.md](06-accessibility.md) | Keyboard, focus, contrast, screen reader, data-table semantics |
| [07-responsive.md](07-responsive.md) | Breakpoints, table strategy, print |
| [08-governance.md](08-governance.md) | Ownership, how to change the system, drift review, package mapping |
| [pages/](pages/) | **One folder per page** — the design system *of that page* |

## Page documents

Every screen in the product has its own folder under [`pages/`](pages/) containing a `README.md`
that states, for that page only: route, archetype, anatomy, components used, columns and their
formatting, actions and their gating, every state, the financial rules that apply, responsive and
accessibility notes, and the open questions.

Start at [pages/README.md](pages/README.md) — the page index.

A page is not "designed" until its folder exists and its `README.md` is filled in.
A page is not "done" until the built screen matches it.

## Naming

- Kit components live in `packages/ui` and are imported, never copied.
- A page-local component is allowed only when the page doc names it under *Page-local components*
  and explains why the kit cannot serve it. Three page-local components doing the same job is a
  defect — raise it with the `design-system` agent instead of building the fourth.
