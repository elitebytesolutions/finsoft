import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { cruise } from 'dependency-cruiser'
import { REPO_ROOT } from '@finsoft/database/testing'
import { afterEach, describe, expect, it } from 'vitest'

/*
 * The negative control for the module graph. Every rule here is proved to
 * FIRE against a file that violates it.
 *
 * ── Why this exists, specifically ───────────────────────────────────────
 *
 * `.dependency-cruiser.cjs` encodes ARCHITECTURE §5 and ADR-0013/0016. Twice
 * now it has reported a clean graph while enforcing nothing:
 *
 *   1. `options.exclude` listed `node_modules` alongside `doNotFollow`.
 *      `exclude` removes the node AND THE EDGES TO IT, so every rule whose
 *      `to.path` targets `^node_modules/` matched nothing — including the two
 *      import boundaries ADR-0013 exists to enforce. Inert from the day it was
 *      written.
 *
 *   2. After that was fixed, `dist` was still in the same pattern, unanchored,
 *      and `node_modules/kysely/dist/index.js` matches it. So
 *      `kysely-is-allowlisted` stayed inert through the review that found the
 *      first defect and was explicitly hunting for more of it. Five files
 *      import `kysely`; the graph contained zero `kysely` edges.
 *
 * Both were invisible in exactly the same way: `npm run depcruise` printed "no
 * dependency violations found" and a larger module count each time it was
 * repaired. A rule that has never fired is a comment, and a comment that looks
 * like a rule is worse than no rule at all, because the next reviewer trusts
 * it and stops looking.
 *
 * ── How it works ────────────────────────────────────────────────────────
 *
 * Each case writes a probe file at a path the rule targets, importing
 * something the rule forbids, cruises it against the REAL ruleset — this file
 * imports `.dependency-cruiser.cjs` directly rather than restating it — and
 * asserts the named rule fires. The probe is then deleted.
 *
 * Probes are written into the real tree because the rules are path-based:
 * `^packages/accounting-kernel/` cannot match a temporary directory. They are
 * gitignored and excluded from tsconfig and ESLint, so an interrupted run
 * leaves nothing that can be committed or that poisons another gate.
 */

const ROOT = REPO_ROOT

/**
 * The REAL config, loaded rather than restated.
 *
 * Through `createRequire` because `.dependency-cruiser.cjs` is CommonJS and
 * ships no types; the shape below names only what this file reads, so a
 * change to either field is a type error here rather than a silently
 * vacuous test.
 */
interface DepcruiseConfig {
  /* Not `readonly`: cruise() takes a mutable IForbiddenRuleType[]. */
  readonly forbidden: Parameters<typeof cruise>[1] extends infer O
    ? O extends { ruleSet?: { forbidden?: infer F } }
      ? F
      : never
    : never
  readonly options: Record<string, unknown> & { readonly exclude: { readonly path: string } }
}

const config = createRequire(join(ROOT, 'noop.cjs'))('./.dependency-cruiser.cjs') as DepcruiseConfig

/** Distinctive enough to grep for, and matched by the ignore patterns. */
const probeName = (n: number): string => `__depcruise_probe_${n}__.ts`

let written: string[] = []

function probe(relativeDir: string, source: string): string {
  const path = join(relativeDir, probeName(written.length))
  const absolute = join(ROOT, path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, source, 'utf8')
  written.push(absolute)
  return path.replaceAll('\\', '/')
}

afterEach(() => {
  for (const path of written) rmSync(path, { force: true })
  written = []
})

/**
 * Cruise a single probe against the real ruleset and return the rules that
 * fired on it.
 *
 * Cruising the probe alone rather than the whole graph keeps each case
 * independent and fast, and means a failure names one file.
 */
async function rulesFiredOn(path: string): Promise<string[]> {
  const result = await cruise([path], {
    ...config.options,
    ruleSet: { forbidden: config.forbidden },
    validate: true,
  })

  if (typeof result.output === 'string') throw new Error('expected a cruise result object')

  return result.output.summary.violations.map((v) => v.rule.name)
}

interface Case {
  readonly rule: string
  readonly dir: string
  readonly source: string
  /** What a reader needs to know about why this boundary exists. */
  readonly because: string
}

const CASES: readonly Case[] = [
  {
    rule: 'kernel-imports-only-allowed',
    dir: 'packages/accounting-kernel/src',
    source: "import '@finsoft/observability'\n",
    because:
      'ARCHITECTURE §5 is an allow-list of three packages and "and NOTHING else" is the ' +
      'strongest sentence in that document. A logger inside the posting engine would be ' +
      'the first exception.',
  },
  {
    rule: 'observability-importers-are-allowlisted',
    dir: 'packages/validation/src',
    source: "import '@finsoft/observability'\n",
    because:
      'ADR-0016: the importer side of the logger boundary. Until this rule existed, the ' +
      'first `packages/database -> observability` edge was legal only because nobody had ' +
      'written a rule.',
  },
  {
    rule: 'observability-imports-almost-nothing',
    dir: 'packages/observability/src',
    source: "import '@finsoft/database'\n",
    because:
      'ADR-0016: the logger sits beneath everything that logs. A first-party dependency ' +
      'here is reachable from every layer that logs, making the logger a back door into it.',
  },
  {
    rule: 'domain-does-not-log',
    dir: 'modules/probe/domain',
    source: "import '@finsoft/observability'\n",
    because:
      'ARCHITECTURE §2: the domain layer is pure TypeScript with no I/O. It returns a ' +
      'result or throws; the application layer decides what is worth a line.',
  },
  {
    rule: 'domain-has-no-infrastructure-deps',
    dir: 'modules/probe/domain',
    source: "import '@finsoft/database'\n",
    because:
      'Same layer, same reason: an ORM in the domain is infrastructure in the one place ARCHITECTURE keeps free of it.',
  },
  {
    rule: 'web-is-ui-only',
    dir: 'apps/web/src',
    source: "import '@finsoft/database'\n",
    because:
      'Rule 19 and ARCHITECTURE §5: the browser bundle reaches ui, shared-types and ' +
      'validation. Never the database, never a kernel, never a module internal.',
  },
  {
    rule: 'pg-driver-is-database-package-only',
    dir: 'modules/probe/infrastructure',
    source: "import { Pool } from 'pg'\nexport const p = Pool\n",
    because:
      'ADR-0013: one pool per process, configured in one place. A second Pool is a second ' +
      'set of rules, and ADR-0004:118 calls pool discipline "the one way RLS can be ' +
      'defeated by configuration". THIS IS THE RULE DEFECT 1 MADE INERT.',
  },
  {
    rule: 'kysely-is-allowlisted',
    dir: 'modules/probe/domain',
    source: "import { sql } from 'kysely'\nexport const s = sql\n",
    because:
      'ADR-0013: the query builder is reachable from the allow-list only. ' +
      'THIS IS THE RULE DEFECT 2 MADE INERT — it matched nothing through two reviews.',
  },
  {
    rule: 'one-decimal-library',
    dir: 'modules/probe/domain',
    source: "import Decimal from 'decimal.js'\nexport const d = Decimal\n",
    because:
      'ADR-0014: the decimal constructor is configured once, in packages/validation. A ' +
      'second import is a second rounding mode, and money computed two ways.',
  },
  {
    rule: 'no-testing-outside-database',
    dir: 'modules/probe/domain',
    source: "import { runAs } from '@finsoft/database/testing'\nexport const r = runAs\n",
    because:
      'M1-X, Security seat final check 3: this is the module-graph half of the ' +
      "testing-import ban — ESLint's no-restricted-imports matches the specifier as " +
      'written and would miss the same file reached by a relative path; this rule ' +
      'does not care how the edge was spelled.',
  },
  {
    rule: 'no-provisioning-outside-owners',
    dir: 'modules/probe/domain',
    source:
      "import { createTenant } from '@finsoft/database/provisioning'\nexport const c = createTenant\n",
    because:
      'M1-X, Security seat final check 3: provisioning writes no audit row and is reachable ' +
      'only from tools/seed/** or packages/database itself, by any path.',
  },
  {
    rule: 'no-request-scope-outside-guard',
    dir: 'modules/probe/domain',
    source:
      "import { withTenantAsPrincipal } from '@finsoft/database/request-scope'\n" +
      'export const w = withTenantAsPrincipal\n',
    because:
      'M1-X, Council T1 / Security seat final check 3: request-scope has exactly one ' +
      'legitimate caller, permission.guard.ts, by any path.',
  },

  /* -------------------------------------------------------------- *
   * ADR-0028, C9: probes for the boundary rules M3-C makes fireable
   * for the first time (modules/customers is the first real module,
   * so every one of these targets a REAL file of it) plus C2-C5.
   * -------------------------------------------------------------- */
  {
    rule: 'no-cross-module-internals',
    dir: 'modules/probe/application',
    source: "import '../../customers/domain/customer.ts'\n",
    because:
      'ARCHITECTURE §5: modules/receivables may not import modules/customers/domain/*. Before ' +
      'M3, this rule had never had a second module to check against — modules/ was empty.',
  },
  {
    rule: 'domain-is-pure',
    dir: 'modules/probe/domain',
    source: "import '../../customers/application/create-customer.ts'\n",
    because:
      'ARCHITECTURE §2: domain/ imports nothing from any module’s api/application/' +
      'infrastructure, its own or another’s.',
  },
  {
    rule: 'application-does-not-import-api',
    dir: 'modules/probe/application',
    source: "import '../../customers/api/schemas.ts'\n",
    because: 'ARCHITECTURE §2: dependencies point inward. api -> application, never back.',
  },
  {
    rule: 'modules-do-not-reach-into-kernels',
    dir: 'modules/probe/application',
    source: "import '../../../packages/accounting-kernel/src/posting-engine.ts'\n",
    because:
      'ADR-0005/0008: a module raises a typed financial event through the kernel’s public ' +
      'index only — it never reaches past index.ts into the kernel’s own internals.',
  },
  {
    rule: 'cross-module-via-published-only',
    dir: 'modules/probe/application',
    source: "import '../../customers/application/create-customer.ts'\n",
    because:
      'ADR-0028 statement 3 / C2: the only file of customers reachable from another module is ' +
      'application/published.ts. create-customer.ts is customers’ own internal use case.',
  },
  {
    rule: 'infrastructure-reaches-application-only-via-ports',
    dir: 'modules/customers/infrastructure',
    source: "import '../application/create-customer.ts'\n",
    because:
      'ADR-0028 statement 5: infrastructure/ -> application/ports.ts is the one sanctioned ' +
      'edge. Reaching a use case file directly is exactly the coupling ports.ts exists to ' +
      'prevent.',
  },
  {
    rule: 'application-does-not-import-infrastructure',
    dir: 'modules/customers/application',
    source: "import '../infrastructure/customers.repository.ts'\n",
    because:
      'ADR-0028 statement 5: a repository is built by index.ts and passed IN to a use case — ' +
      'a use case never imports infrastructure/ to build its own.',
  },
  {
    rule: 'module-api-does-not-import-infrastructure',
    dir: 'modules/customers/api',
    source: "import '../infrastructure/customers.repository.ts'\n",
    because:
      'ADR-0028 statement 4: the api/ layer is framework-free mapping and validation — it has ' +
      'no business holding a repository.',
  },
  {
    rule: 'domain-imports-allowlisted',
    dir: 'modules/customers/domain',
    source: "import '../infrastructure/customers.repository.ts'\n",
    because:
      'ADR-0028 statement 5: domain/ imports only its own files, @finsoft/validation, ' +
      '@finsoft/shared-types, and the kernel index type-only. Its own module’s ' +
      'infrastructure/ is not on that list either.',
  },
  {
    rule: 'apps-import-module-index-only',
    dir: 'apps/api/src',
    source: "import '../../../modules/customers/application/create-customer.ts'\n",
    because:
      'ADR-0028 statement 3: apps/api reaches a module through "." -> ./index.ts alone. ' +
      'Reaching past it into application/ is the same private-internals violation ' +
      'no-cross-module-internals forbids between two modules.',
  },
  {
    rule: 'modules-import-allowlisted',
    dir: 'modules/probe/infrastructure',
    source: "import '@finsoft/permissions'\n",
    because:
      'ADR-0028 statement 5: a module never imports @finsoft/permissions — RBAC resolution is ' +
      'apps/api’s concern (the PermissionGuard / @RequirePermission boundary), never a module’s.',
  },
]

describe('every boundary rule fires against a file that violates it', () => {
  it.each(CASES)('$rule', async ({ rule, dir, source }) => {
    const path = probe(dir, source)
    const fired = await rulesFiredOn(path)

    expect(
      fired,
      `${rule} did not fire on ${path}. A rule that cannot fire enforces nothing, and the ` +
        'graph will still report clean — that is exactly how this file came to exist. ' +
        'Check options.exclude before assuming the rule text is wrong.',
    ).toContain(rule)
  })
})

describe('ports-import-is-type-only (ADR-0028 C3) — a value import of ports.ts', () => {
  /*
   * modules/customers/application/ports.ts exports interfaces only, so an
   * ordinary `import {...} from '...ports.ts'` is ALREADY type-only by
   * construction — there is nothing else it could be. To prove this rule
   * actually fires on a genuine VALUE import (not merely "no probe happened
   * to trip it"), the probe module gets its own ports.ts with a runtime
   * export, and a sibling file imports it as a value.
   */
  it('fires when a ports.ts is imported for its VALUE, not just its types', async () => {
    probe('modules/probe2/application', 'export const RUNTIME_VALUE_NOT_A_TYPE = 1\n')
    // The file above lands at a generated name, not literally "ports.ts" —
    // write the real target directly so the rule's own path pattern
    // (^modules/([^/]+)/application/ports\.ts$) matches it.
    const portsAbs = join(ROOT, 'modules/probe2/application/ports.ts')
    mkdirSync(dirname(portsAbs), { recursive: true })
    writeFileSync(portsAbs, 'export const RUNTIME_VALUE_NOT_A_TYPE = 1\n', 'utf8')
    written.push(portsAbs)

    const importerPath = probe(
      'modules/probe2/infrastructure',
      "import { RUNTIME_VALUE_NOT_A_TYPE } from '../application/ports.ts'\n" +
        'export const x = RUNTIME_VALUE_NOT_A_TYPE\n',
    )

    const fired = await rulesFiredOn(importerPath)
    expect(
      fired,
      'ports-import-is-type-only did not fire on a genuine VALUE import of a ports.ts file',
    ).toContain('ports-import-is-type-only')
  })

  it('does not fire on the real, type-only import customers/infrastructure actually uses', async () => {
    const result = await cruise(['modules/customers/infrastructure/customers.repository.ts'], {
      ...config.options,
      ruleSet: { forbidden: config.forbidden },
      validate: true,
    })
    if (typeof result.output === 'string') throw new Error('expected a cruise result object')
    const rules = result.output.summary.violations.map((v) => v.rule.name)
    expect(rules).not.toContain('ports-import-is-type-only')
  })
})

describe('domain-kernel-import-is-type-only (ADR-0028 statement 5)', () => {
  it('fires on a runtime (value) import of the kernel from domain/', async () => {
    const path = probe(
      'modules/probe/domain',
      "import { registerParty } from '@finsoft/accounting-kernel'\nexport const r = registerParty\n",
    )
    const fired = await rulesFiredOn(path)
    expect(fired).toContain('domain-kernel-import-is-type-only')
  })

  it('leaves a type-only kernel import from domain/ alone', async () => {
    const path = probe(
      'modules/probe/domain',
      "import type { PostingErrorCode } from '@finsoft/accounting-kernel'\n" +
        'export type X = PostingErrorCode\n',
    )
    const fired = await rulesFiredOn(path)
    expect(fired).not.toContain('domain-kernel-import-is-type-only')
  })
})

describe('the harness itself discriminates', () => {
  /*
   * Without this, every case above would pass against a cruiser that reported
   * every rule on every file — the same vacuity the rules themselves had.
   */
  it('reports no violations for a file that breaks nothing', async () => {
    const path = probe('modules/probe/domain', 'export const nothing = 1\n')
    expect(await rulesFiredOn(path)).toEqual([])
  })

  it('reports ONLY the violated rule, not every rule', async () => {
    const path = probe('modules/probe/domain', "import 'decimal.js'\n")
    const fired = await rulesFiredOn(path)

    expect(fired).toContain('one-decimal-library')
    expect(fired, 'a kernel rule must not fire on a module file').not.toContain(
      'kernel-imports-only-allowed',
    )
    expect(fired, 'the web rule must not fire on a module file').not.toContain('web-is-ui-only')
  })
})

describe('the exclusion that broke the rules twice', () => {
  const excluded = new RegExp(config.options.exclude.path)

  /*
   * Pinned as a test rather than trusted as a comment. Both defects were a
   * pattern written for first-party build output that also matched a
   * DEPENDENCY's published directory — which is what publishing looks like.
   */
  it.each([
    'node_modules/kysely/dist/index.js',
    'node_modules/pg/lib/index.js',
    'node_modules/decimal.js/decimal.mjs',
    'node_modules/.pnpm/zod@3/node_modules/zod/dist/index.js',
  ])('does not exclude %s — the rules target node_modules and need it in the graph', (path) => {
    expect(
      excluded.test(path),
      'excluding this puts the node AND its edges out of the graph, so every ^node_modules/ ' +
        'rule silently matches nothing while depcruise reports a clean run',
    ).toBe(false)
  })

  it.each([
    'apps/web/.next/static/x.js',
    'packages/ui/dist/index.js',
    'packages/database/coverage/x.js',
    'ui-prototype/x.js',
    'tools/parity/x.js',
  ])('still excludes our own build output: %s', (path) => {
    expect(excluded.test(path)).toBe(true)
  })
})

describe('a types-first dependency is visible to the rules', () => {
  /*
   * A STANDING GUARD, not a negative control — and the distinction is the
   * point.
   *
   * A review flagged that `zod`, which resolves to `index.d.cts`, produced no
   * edges because no declaration extension was configured, and that any rule
   * naming a types-first dependency would therefore be inert in the way
   * `kysely-is-allowlisted` was. It was a plausible third instance of the
   * defect that had already appeared twice.
   *
   * It does not reproduce. Measured against the exact pre-fix config, `zod`
   * resolves with the six runtime extensions alone, because `exportsFields`
   * and the `types` condition hand enhanced-resolve an exact path and the
   * extension list is never consulted. Adding the declaration extensions
   * moved the graph by minus one module and zero dependencies. The config
   * change was reverted; this test is what is left, and it is worth keeping
   * on its own terms: types-first resolution IS load-bearing for every
   * `^node_modules/` rule, and nothing else asserts it.
   *
   * `zod` is the probe because it is the types-first dependency the
   * repository actually has. If it is ever removed, replace the probe rather
   * than deleting the test.
   */
  it('produces edges for zod, which resolves to a .d.cts file', async () => {
    const result = await cruise(['packages/validation/src/schemas.ts'], {
      ...config.options,
      ruleSet: { forbidden: config.forbidden },
      validate: true,
    })

    if (typeof result.output === 'string') throw new Error('expected a cruise result object')

    const resolved = result.output.modules.flatMap((m) =>
      m.dependencies.map((d) => d.resolved as string),
    )

    expect(
      resolved.filter((r) => r.includes('node_modules/zod')),
      'zod resolved to nothing. Check enhancedResolveOptions.extensions for the declaration ' +
        'extensions (.d.ts/.d.cts/.d.mts) — without them a types-first package is invisible ' +
        'to every rule, and depcruise still reports a clean graph.',
    ).not.toHaveLength(0)
  })
})
