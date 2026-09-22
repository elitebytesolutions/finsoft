# apps/web — the FinSoft frontend

Next.js (App Router) + TypeScript. This is the official frontend. It was ported from
`ui-prototype/`, which remains the visual reference and the source of truth for parity.

```bash
npm run dev          # this app          -> http://localhost:3000
npm run prototype    # the reference     -> http://localhost:5174
npm run typecheck
npm test
npm run parity       # screenshot diff, both servers must be up
```

## How the port is arranged

```
app/<segment>/page.tsx    77 route segments. Thin: <Guard> + screen + props.
src/screens/              48 screen components, bodies verbatim from the prototype.
src/components/shell.tsx  sidebar, top bar, role switcher, footer.
src/lib/router.tsx        react-router-dom shim over next/navigation.
src/app-context.tsx       the state App.tsx used to hold: mock store + active role.
src/mocks/                demo data, localStorage store, and the façade over both.
```

The screens were moved **body-identical** — only import specifiers changed. That is what
makes `npm run parity` a meaningful test, and why you should not tidy a screen's JSX
without understanding that you are giving that up. See the `port-prototype-screen` skill.

`src/lib/router.tsx` exists so those bodies did not have to be rewritten. It implements the
six react-router APIs the prototype uses. It is scaffolding, not architecture — delete it
when the screens are rewritten against `next/navigation` directly.

## What is not real yet

Everything under `src/mocks/` is demo state in `localStorage` (key `finsoft-data-v7`).
It computes balances, builds journal lines and mutates stock **in the browser**, which
`docs/ARCHITECTURE.md` §2 explicitly forbids: *"if the browser is deciding a number, that
is a bug."*

That logic is quarantined behind `src/mocks/api.ts` rather than spread across 77 routes,
so when the NestJS API and the accounting/inventory kernels land, that file changes and
the screens do not. Until then: **no figure in this app has been posted to a ledger.**

`<Guard>` hides modules a role may not open. It is a UI affordance and authorises nothing.

## Styling

`packages/ui/src/tokens/*.css` — the design tokens, named per
`docs/design-system/01-foundations.md`.
`packages/ui/src/styles/kit.css` — the prototype's stylesheet, moved byte-for-byte.

The kit stylesheet is full of raw hex and is known, tracked debt. Tokenising it is its own
task with its own parity run. Do not add to it and do not opportunistically "fix" it.

One trap worth knowing: the font stack names `Inter` first but the app only ever fetches
**Caveat**. Inter resolves to the local UI font. Loading Inter properly would change every
glyph on every screen — it is deliberate, not an oversight.
