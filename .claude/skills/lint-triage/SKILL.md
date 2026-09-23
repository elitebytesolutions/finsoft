---
name: lint-triage
description: Work through a wall of ESLint errors in FinSoft without hiding them. Use when `npm run lint` fails, when there are dozens or hundreds of errors at once, when someone asks to "make lint pass", or when deciding whether a rule is wrongly configured, whether an eslint-disable is justified, or which errors are architectural violations that must be reported rather than fixed.
---

# Lint triage

Lint checks code against rules that catch common mistakes and keep it consistent — unused
variables, unsafe types, missing imports, forbidden dependencies.

**143 lint errors does not mean 143 broken features.** One configuration mistake produces
dozens of errors. Group before you fix, or you will fix the same cause forty times.

## Read this first: most FinSoft lint rules are not style

`eslint.config.mjs` is the mechanical half of the ADRs. Each block cites the document it
enforces. Prettier owns formatting and is switched off in ESLint; dependency-cruiser owns
the module graph. What is left in ESLint is mostly **invariants**:

| Rule that fires | What it actually means |
|---|---|
| `no-restricted-imports` (decimal libs) | ADR-0011/0014 — money is being computed outside `@finsoft/validation` |
| `no-restricted-imports` (kernels, `@finsoft/database`, `kysely`, `pg` in `apps/web`) | ARCHITECTURE §5 / rule 19 — a layer is reaching where it may not |
| `no-restricted-imports` in `modules/*/domain/**` | ARCHITECTURE §2 — the pure domain layer grew a framework or an ORM |
| `no-restricted-syntax` → `setTypeParser`, `pg.defaults` | ADR-0013 — numeric/int8 would stop arriving as strings |
| `no-restricted-syntax` → `sql.raw` | ADR-0013 — unparameterised SQL |
| `no-restricted-syntax` → `db.schema`, `new Migrator` | ADR-0013 — DDL belongs in `database/migrations/*.sql` |
| `no-restricted-syntax` → `Decimal.set` / `FinDecimal.set` | ADR-0014 — the decimal constructor is frozen at one site |
| `no-restricted-syntax` → `bypassPeriod`, `forcePost`, `systemActor` | ADR-0012 — a closed-period bypass is being built |
| `no-restricted-syntax` → `it.skip` / `it.only` | AGENTS.md rule 4 — a test is being silenced |
| `@typescript-eslint/no-explicit-any` | The type system is being switched off, usually over a boundary |

**A hit on any of these is a finding, not a chore.** Do not refactor around it, do not
narrow the rule, do not add a disable. Stop, and report it — these are exactly the
"financial invariant violation" and "outside your boundary" cases in `CLAUDE.md` and
AGENTS.md rule 20. If the violating code is inside your `ALLOWED` paths and the correct fix
is genuinely local, fix it properly; if the fix would need a kernel, the permission model,
tenancy or a released migration to change, report instead.

## The order of work

### 1. Group the errors

Never start from the top of the output. Count by rule first:

```bash
npx eslint . -f json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const by={};for(const f of JSON.parse(s))for(const m of f.messages){const k=m.ruleId??'(parse error)';by[k]=(by[k]??0)+1}console.log(Object.entries(by).sort((a,b)=>b[1]-a[1]).map(([r,c])=>String(c).padStart(5)+'  '+r).join('\n'))})"
```

Then by file, to find the one file that is producing most of them:

```bash
npx eslint . -f json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log(JSON.parse(s).filter(f=>f.messages.length).map(f=>[f.messages.length,require('path').relative(process.cwd(),f.filePath)]).sort((a,b)=>b[0]-a[0]).slice(0,20).map(([n,p])=>String(n).padStart(5)+'  '+p).join('\n'))})"
```

Both read `-f json`. ESLint 10 dropped the `compact` and `unix` formatters, and parsing
`stylish` output with `cut -d:` breaks on Windows drive letters — use JSON.

Separate errors from warnings while you are at it — `no-console` and
`react-hooks/exhaustive-deps` are `warn` here and do not fail `npm run lint`. Fixing a
warning is optional work; say so rather than quietly spending the budget on it.

Report the grouping before you change anything. "143 errors" is not a plan; "128 of them
are `no-undef` in four `tools/*.mjs` files that are missing a globals block" is.

### 2. Check the configuration before you change code

Ask whether the errors are real before fixing them. The config already ignores
`node_modules`, `.next`, `dist`, `coverage`, `ui-prototype`,
`packages/database/src/generated`, `tools/parity` and `next-env.d.ts`.

Signals that the config is wrong rather than the code:

- Hundreds of `no-undef` / parser errors concentrated in one directory → a missing
  `languageOptions.globals` or `sourceType` block for that file type (see the `*.cjs` and
  `tools/**/*.mjs` blocks for the pattern).
- Errors in generated or build output → an ignore is missing, or a generator is writing
  outside its expected path. Fix the path or the ignore.
- A rule firing on the file that legitimately owns the thing it bans → the config needs a
  scoped override, exactly like the `packages/validation` block that turns off
  `no-restricted-imports` because that is the one place the decimal library lives.

**Report a suspected misconfiguration before changing `eslint.config.mjs`.** That file
encodes ADRs; loosening a rule there is an ADR change, not a lint fix. Adding a globals
block for a script directory is fine. Removing a restricted import, widening an ignore to
cover our own source, or dropping a `no-restricted-syntax` selector is not.

### 3. Apply automatic fixes, then read the diff

```bash
npm run lint:fix
git diff --stat
git diff
```

Autofix is safe for import order, unused imports and simple syntax. It is not a substitute
for reading the change. Inspect the diff before continuing — an autofix that deleted an
import something else needed at runtime will show up here, not in lint.

### 4. Fix what is left, in small groups by cause

Work one rule at a time and commit per group, so a reviewer can follow it.

**Unused variables** (`@typescript-eslint/no-unused-vars`). In scaffolding — a placeholder
package or a stub module from an earlier wave — the right fix is almost always to **delete
the unused scaffolding**, not to invent functionality that makes it used, and not to prefix
everything with `_`. The `^_` ignore pattern is for genuinely-required-but-unused
parameters (an interface signature you must match), not for hiding dead code. If deleting
is outside your `ALLOWED` paths, say so in `OBSERVED` and leave it.

**`any`** (`@typescript-eslint/no-explicit-any`, an error here). Give the value its real
type, or `unknown` plus a validated narrowing at the boundary. `any` on a money, tenant or
posting path is the failure mode the rule exists to catch. Never `@ts-ignore`,
`@ts-expect-error` or a cast through `unknown` to make it quiet.

**Promises and async.** An unhandled rejection in a posting path is a swallowed posting
error — AGENTS.md rule 12. `await` it, or return it to a caller that does. Never
`.catch(() => {})`.

**Imports and boundaries.** See the table above. Cross-check against
`npm run depcruise`: ESLint sees syntax, dependency-cruiser sees the module graph, and a
boundary violation usually trips both. Fixing the ESLint error without fixing the graph
just moves the violation.

**React hooks.** `rules-of-hooks` is an error and is always a real bug. `exhaustive-deps`
is a warning — fix the dependency array properly or leave it; do not disable the line to
make it green.

### 5. Verify, and keep the three checks separate

```bash
npm run lint        # suspicious code and rule violations
npm run typecheck   # TypeScript compatibility
npm test            # behaviour: balanced postings, tenant isolation, audit records
npm run depcruise   # module boundaries
npm run verify      # typecheck + lint + depcruise + format:check + test — the full gate
```

These answer different questions and are not interchangeable. Green lint says nothing about
whether a journal entry balances. If a lint fix changed behaviour — a dependency array, a
removed import, a narrowed type, deleted scaffolding — run the tests that cover it and say
which ones you ran.

## Never do these

```ts
// WRONG — every one of these reports success while the problem stays
const total: any = ...                       // switching off the type system
// eslint-disable-next-line                   // no rule named, no reason given
/* eslint-disable @typescript-eslint/no-explicit-any */  // file-wide amnesty
// @ts-ignore                                 // a different checker, same evasion
it.skip('trial balance must balance', ...)    // AGENTS.md rule 4
```

And in `eslint.config.mjs`: do not delete a restricted import, weaken a
`no-restricted-syntax` selector, or extend `ignores` to cover our own source.

### When a disable is legitimate

Rarely, and never for a rule in the table at the top. It must name the specific rule, sit
on the narrowest possible scope, and carry a reason a reviewer can evaluate:

```ts
// eslint-disable-next-line no-console -- structured startup log, before the logger exists
console.log(`listening on ${port}`)
```

A disable with no rule name or no reason is rejected in review.

## Reporting

Use the standard report shape from `CLAUDE.md`:

- **DONE** — what now passes, by rule group, with before/after counts.
- **FILES** — grouped by cause, not an alphabetical list.
- **TESTS** — lint, typecheck, depcruise, and the behavioural tests you ran for anything
  that changed behaviour.
- **DECISIONS** — every disable added and why; every config change and why.
- **BLOCKED** — rules you believe are misconfigured, stated but not changed.
- **OBSERVED** — invariant or boundary violations the linter surfaced that are outside your
  `ALLOWED` paths. These are the most valuable part of the report. A lint run that uncovers
  a period-lock bypass has done more for the books than a green build.

Never report "lint passes" when it passes because rules were disabled. Say which rules, on
which lines, and why.
