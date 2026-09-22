---
name: port-prototype-screen
description: Port a screen, component or route from ui-prototype/ (Vite + react-router) into apps/web (Next.js App Router) without losing pixel parity. Use when moving any remaining prototype code into the official frontend, when a ported screen renders differently from the prototype, or when adding a route that already exists in ui-prototype/src/App.tsx.
---

# Porting a prototype screen into apps/web

`ui-prototype/` is the **reference implementation**, not a sketch. It is what the
business signed off on and what `docs/design-system/pages/` documents. The port's
acceptance criterion is pixel parity, so the method below is built around one rule:

> **Change import lines. Never change the body.**

A screen whose JSX you "cleaned up while you were in there" cannot be diffed against
the prototype any more, and you have silently become the source of truth.

---

## 1. The transform

Copy the file to `apps/web/src/screens/` and rewrite **only** these:

| In the prototype | In apps/web |
|---|---|
| `from 'react-router-dom'` | `from '@/lib/router'` |
| `from './data'`, `from './store'` | `from '@/mocks/api'` |
| `from './ui'`, `from './format'` | `from '@finsoft/ui'` |
| sibling screen, e.g. `from './parties'` | unchanged — same folder |
| *(top of file)* | prepend `'use client'` |

Every screen is a client component. They all use hooks, handlers or `localStorage`.

## 2. Prove you only changed imports

Do not eyeball this. Run it:

```bash
python - <<'PY'
import io, sys
a, b = sys.argv[1], sys.argv[2]
strip = lambda t: '\n'.join(l for l in t.splitlines()
                            if not l.startswith('import ') and l.strip() != "'use client'")
A = strip(io.open(a, encoding='utf-8').read())
B = strip(io.open(b, encoding='utf-8').read())
print('BODY IDENTICAL' if A == B else 'BODY CHANGED — investigate before continuing')
PY
```

If it says CHANGED and you did not intend it, revert and redo. If you *had* to change
the body, that is a finding: write it down in your report with the reason.

## 3. The route segment

`ui-prototype/src/App.tsx` holds the route table. Each row becomes one
`apps/web/app/<path>/page.tsx`. Translate `:id` to `[id]`. Keep the screen's props
**exactly** as the prototype passed them — the props are part of the contract.

```tsx
'use client'
import { ChartOfAccounts } from '@/screens/chart-of-accounts'
import { Guard } from '@/components/guard'
import { useFinsoft } from '@/app-context'

export default function Page() {
  const f = useFinsoft()
  return <Guard module="Cash, Bank & GL">
    <ChartOfAccounts data={f.data} onAdd={f.addMaster} canCreate={f.act('master:create')}/>
  </Guard>
}
```

The prototype's `can('X') ? <Page/> : <Navigate to="/unauthorized"/>` becomes
`<Guard module="X">`. `act('...')` becomes `f.act('...')`.

`Guard` is a **UI affordance only**. It hides what a role may not open. It authorises
nothing. Real authorisation is server-side — see `docs/ARCHITECTURE.md`.

## 4. Traps that have already cost time

Each of these was hit during the initial port. They cost real debugging.

**Dependency majors change rendering.** `ui-prototype/package.json` pins everything to
`"latest"`; its lockfile resolved `lucide-react@1.37.0` and `recharts@3.10.1`. Installing
lucide `0.x` loses icons outright (`ChartPie`, `ChartNoAxesCombined`, `FileChartColumn`)
and recharts 2 vs 3 changes chart geometry. Match the prototype's resolved versions:
```bash
node -e "console.log(require('./ui-prototype/node_modules/lucide-react/package.json').version)"
```

**The font stack is a trap.** `:root` names `Inter` first, but the prototype only ever
fetches **Caveat** from Google Fonts. Inter is never loaded, so it resolves to the local
UI font. Adding `next/font` Inter "to do it properly" changes every glyph on every screen.
Do not load Inter.

**Static image imports differ.** Vite gives a URL string; Next gives `StaticImageData`.
A body that does `url(${img})` renders `[object Object]`. Fix it in the *import area* —
`const img = imgImport.src` — so the usage site stays byte-identical.

**`localStorage` in a `useState` initialiser breaks SSR.** It throws during prerender and
desynchronises hydration. Seed with the default, restore in a `useEffect`, and gate the
write-back on a `hydrated` flag. See `apps/web/src/mocks/store.ts`.

**Rewriting identifiers hits JSX attribute names.** A regex turning `data` into `f.data`
will also rewrite the *prop name* in `data={data}`, producing `f.data={f.data}`. Guard
with a negative lookahead for `=`: `\bdata\b(?!\s*=(?!=))`.

## 5. Verify

```bash
npm run typecheck          # must be clean before you claim anything
npm run parity             # screenshot diff vs the prototype, tools/parity/
```

Both servers need to be up: prototype on `:5174` (`npm run prototype`), Next on `:3000`
(`npm run dev`). A route that differs is a defect in the port, not a threshold to tune.

## 6. Where this stops

The prototype computes balances, builds journal lines and mutates stock **in the browser**.
`docs/ARCHITECTURE.md` §2: "if the browser is deciding a number, that is a bug." That logic
is quarantined in `apps/web/src/mocks/` behind a façade so it can be replaced in one place.

**Do not spread it.** A ported screen may call the façade. It may not grow new arithmetic,
and nothing in `apps/web` may ever construct a journal line for real. When the API lands,
`mocks/api.ts` changes and the screens do not.
