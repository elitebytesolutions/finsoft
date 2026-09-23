/*
 * FinSoft module boundaries.
 *
 * ARCHITECTURE.md §5: "Enforced mechanically by dependency-cruiser in CI, not
 * by good intentions." Each rule below names the document it enforces.
 *
 * This file governs the module graph. Syntax-level ADR rules (type parsers,
 * decimal configuration, period bypass identifiers) live in eslint.config.mjs.
 */

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    /* ------------------------------------------------------------------ *
     * The kernels are the heart of the system. They know nothing else.
     * ARCHITECTURE.md §5, ADR-0001, ADR-0005
     * ------------------------------------------------------------------ */
    {
      name: 'kernel-imports-only-allowed',
      severity: 'error',
      comment:
        'A kernel imports database, validation and shared-types — and nothing else. ' +
        'It knows nothing about feature modules, HTTP or UI.',
      from: { path: '^packages/(accounting-kernel|inventory-kernel)/' },
      to: {
        pathNot: [
          '^packages/(accounting-kernel|inventory-kernel|database|validation|shared-types)/',
          '^node_modules/',
        ],
      },
    },
    {
      name: 'kernel-has-no-network',
      severity: 'error',
      comment:
        'ADR-0001: the kernels have no network. A kernel opening a socket is a build failure.',
      from: { path: '^packages/(accounting-kernel|inventory-kernel)/' },
      to: { dependencyTypes: ['core'], path: '^(http|https|net|tls|dgram)$' },
    },

    /* ------------------------------------------------------------------ *
     * Module internals are private. Cross-module traffic goes through a
     * published application interface or a domain event.
     * ARCHITECTURE.md §5
     * ------------------------------------------------------------------ */
    {
      name: 'no-cross-module-internals',
      severity: 'error',
      comment:
        'modules/sales may not import modules/inventory/domain/*. Cross-module traffic goes ' +
        'through a published application-layer interface or a domain event.',
      from: { path: '^modules/([^/]+)/' },
      to: {
        path: '^modules/([^/]+)/(domain|infrastructure)/',
        pathNot: '^modules/$1/',
      },
    },

    /* ------------------------------------------------------------------ *
     * Layering inside a module: api -> application -> domain,
     * infrastructure -> domain. domain imports none of them.
     * ARCHITECTURE.md §2
     * ------------------------------------------------------------------ */
    {
      name: 'domain-is-pure',
      severity: 'error',
      comment:
        'domain/ is pure TypeScript. It imports nothing from api/, application/ or ' +
        'infrastructure/, and nothing that knows about NestJS, HTTP or the database.',
      from: { path: '^modules/([^/]+)/domain/' },
      to: {
        path: '^modules/([^/]+)/(api|application|infrastructure)/',
      },
    },
    {
      name: 'domain-has-no-infrastructure-deps',
      severity: 'error',
      comment: 'ARCHITECTURE.md §2: no NestJS, no ORM, no HTTP inside a domain layer.',
      from: { path: '^modules/[^/]+/domain/' },
      to: { path: '^(packages/database|node_modules/(kysely|pg|@nestjs|express|fastify))' },
    },
    {
      name: 'application-does-not-import-api',
      severity: 'error',
      comment: 'ARCHITECTURE.md §2: dependencies point inward. api -> application, never back.',
      from: { path: '^modules/([^/]+)/application/' },
      to: { path: '^modules/([^/]+)/api/' },
    },

    /* ------------------------------------------------------------------ *
     * The kernels are the only writers of financial truth.
     * ADR-0005, ADR-0008
     * ------------------------------------------------------------------ */
    {
      name: 'modules-do-not-reach-into-kernels',
      severity: 'error',
      comment:
        'A module raises a typed financial event through the kernel public surface. ' +
        'It never imports kernel internals to build journal lines or movements itself.',
      from: { path: '^modules/' },
      to: {
        path: '^packages/(accounting-kernel|inventory-kernel)/src/(?!index)',
      },
    },

    /* ------------------------------------------------------------------ *
     * The browser holds no business rules and no database.
     * NON_NEGOTIABLES rule 19, ARCHITECTURE.md §5
     * ------------------------------------------------------------------ */
    {
      name: 'web-is-ui-only',
      severity: 'error',
      comment:
        'apps/web reaches packages/ui, shared-types and validation. Never a kernel, never a ' +
        'module internal, never the database. Business logic lives in the backend domain layer.',
      from: { path: '^apps/web/' },
      to: {
        path: '^(packages/(accounting-kernel|inventory-kernel|database|auth|permissions|reporting|observability)|modules)/',
      },
    },

    /* ------------------------------------------------------------------ *
     * Observability. ADR-0016.
     *
     * The kernel import rule above already blocks a kernel from importing
     * @finsoft/observability, because that rule is an allow-list of three
     * packages. These add the two boundaries it does NOT cover.
     * ------------------------------------------------------------------ */
    {
      name: 'domain-does-not-log',
      severity: 'error',
      comment:
        'ADR-0016: a pure domain layer does not log. It returns a result or throws, and the ' +
        'application layer that called it decides what is worth a log line. A logger in the ' +
        'domain is an I/O dependency in the one layer ARCHITECTURE.md §2 keeps free of them.',
      from: { path: '^modules/[^/]+/domain/' },
      to: { path: '^packages/observability/' },
    },
    {
      /*
       * The importer side of the logger boundary. ADR-0016.
       *
       * `observability-imports-almost-nothing` constrains what the logger
       * imports; until this rule existed, nothing constrained who imports IT.
       * `packages/database` was added as the first importer — to redact a pg
       * driver message that was printing a password — and it was legal only
       * because nobody had written a rule, which is the same posture that let
       * the `exclude` defect survive two reviews.
       *
       * So the permission is now an allow-list by exclusion: the packages
       * named here may NOT reach the logger, and the next first-party package
       * that wants it has to change this line. That is a decision, not a
       * default.
       *
       * The kernels are the load-bearing entries. `kernel-imports-only-allowed`
       * already blocks them, but only while they stay empty of everything
       * except the three allowed packages; this states the prohibition
       * directly so it survives the kernels taking their `packages/database`
       * dependency. Note that the transitive reach through `packages/database`
       * is real and accepted: its `index.ts` re-exports nothing from
       * observability, so `getLogger` is not nameable through the allowed
       * edge.
       */
      name: 'observability-importers-are-allowlisted',
      severity: 'error',
      comment:
        'ADR-0016: the logger is reachable from apps, modules (outside domain) and the ' +
        'lower-level packages that may log. A kernel, shared-types, ui and validation may ' +
        'not reach it. Adding an importer is an edit to this rule, not a new import.',
      from: {
        path: '^packages/(accounting-kernel|inventory-kernel|shared-types|ui|validation)/',
      },
      to: { path: '^packages/observability/' },
    },
    {
      name: 'observability-imports-almost-nothing',
      severity: 'error',
      comment:
        'ADR-0016: the logger sits beneath everything that logs, so it imports nothing from ' +
        'this repo except shared-types. A dependency here would be reachable from every ' +
        'layer that logs, and would make the logger a back door into it.',
      from: { path: '^packages/observability/' },
      to: {
        /*
         * `node:async_hooks` carries the correlation context and `node:crypto`
         * mints the ids, so core modules are exempt. The point of the rule is
         * that no FIRST-PARTY package is reachable from here.
         */
        dependencyTypesNot: ['core'],
        pathNot: ['^packages/(observability|shared-types)/', '^node_modules/'],
      },
    },

    /* ------------------------------------------------------------------ *
     * Connection ownership. ADR-0013.
     * pg is packages/database only. kysely is allowlisted more widely,
     * because ADR-0005 puts journal-writing repositories in the accounting
     * kernel and ARCHITECTURE.md §2 puts repositories in module
     * infrastructure layers.
     * ------------------------------------------------------------------ */
    {
      name: 'pg-driver-is-database-package-only',
      severity: 'error',
      comment:
        'ADR-0013: connection ownership — Pool construction and the pg driver live in ' +
        'packages/database and nowhere else.',
      from: { pathNot: '^packages/database/' },
      to: { path: '^node_modules/(pg|pg-types|pg-pool)/' },
    },
    {
      name: 'kysely-is-allowlisted',
      severity: 'error',
      comment:
        'ADR-0013: query construction is allowed in packages/database, the kernels, ' +
        'packages/reporting and module infrastructure layers. Nowhere else.',
      from: {
        pathNot: [
          '^packages/(database|accounting-kernel|inventory-kernel|reporting)/',
          '^modules/[^/]+/infrastructure/',
        ],
      },
      to: { path: '^node_modules/kysely/' },
    },

    /* ------------------------------------------------------------------ *
     * One decimal implementation. ADR-0011, ADR-0014.
     * ------------------------------------------------------------------ */
    {
      name: 'one-decimal-library',
      severity: 'error',
      comment:
        'ADR-0014: decimal.js is imported in packages/validation and nowhere else. ' +
        'One library, one configuration, one rounding mode.',
      from: { pathNot: '^packages/validation/' },
      to: { path: '^node_modules/(decimal\\.js|decimal\\.js-light|big\\.js|bignumber\\.js)/' },
    },

    /* ------------------------------------------------------------------ *
     * General hygiene
     * ------------------------------------------------------------------ */
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'A cycle makes reasoning about transaction and posting order impossible.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-to-dev-dep',
      severity: 'error',
      comment: 'Production code may not depend on a devDependency.',
      from: {
        path: '^(apps|packages|modules)/',
        /*
         * Test and build-configuration files legitimately use devDependencies
         * — that is what a devDependency is. Excluded: spec files, vitest and
         * playwright configs, and anything under a `test/` directory.
         */
        pathNot:
          '\\.(spec|test)\\.[tj]sx?$|(^|/)(vitest|playwright)[^/]*\\.config\\.[tj]s$|(^|/)test/',
      },
      to: {
        dependencyTypes: ['npm-dev'],
        /*
         * A TYPE-ONLY import of a devDependency is not a runtime dependency —
         * it is erased before the code runs. `import type { Response } from
         * 'express'` against @types/express is correct and must not be
         * flagged; an ordinary import of the same module would still be.
         *
         * Needed because tsPreCompilationDeps is on, which is what lets the
         * kernel and boundary rules see type-only edges they SHOULD catch.
         */
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'no-deprecated-core',
      severity: 'error',
      from: {},
      to: { dependencyTypes: ['core'], path: '^(punycode|domain|sys|querystring)$' },
    },
  ],

  options: {
    /*
     * `doNotFollow` keeps a node in the graph and stops traversing INTO it.
     * `exclude` removes the node AND THE EDGES TO IT.
     *
     * node_modules must be in the first and NOT the second. It was in both,
     * and the consequence was silent and total: every rule whose `to.path`
     * targets `^node_modules/` could never fire, because no such module was
     * in the graph to match. That is `pg-driver-is-database-package-only`,
     * `kysely-is-allowlisted`, `one-decimal-library` and `not-to-dev-dep` —
     * including the two import boundaries ADR-0013 exists to enforce.
     *
     * The symptom was invisible: `npm run depcruise` reported "no dependency
     * violations found" across 273 modules, and `packages/database/src/pool.ts`
     * — which imports `pg` on line 1 — showed exactly one dependency, `env.ts`.
     * A clean report from a cruiser that cannot see the thing it is looking for.
     */
    doNotFollow: { path: 'node_modules' },
    /*
     * The same defect, a second time, and it survived the review that found
     * the first one.
     *
     * Removing `node_modules` from `exclude` was not enough: `dist` was still
     * here, unanchored, and `node_modules/kysely/dist/index.js` matches it.
     * So `kysely-is-allowlisted` went on matching nothing while the graph
     * looked healthy — five files import `kysely` (`kysely.ts`,
     * `repository.ts`, `transaction.ts`, `testing/harness.ts` and the
     * generated schema) and the graph contained zero `kysely` edges.
     *
     * The lesson is not "remember dist". It is that an `exclude` pattern
     * written for first-party build output will silently also match a
     * DEPENDENCY's published directory, because that is what publishing
     * looks like. So the pattern is anchored: build output is excluded only
     * OUTSIDE node_modules. Anything under node_modules is left to
     * `doNotFollow`, which keeps the node and its edges and merely stops
     * traversing into it.
     *
     * `tools/depcruise-negative-control.spec.ts` fails if either rule stops
     * matching its probe, so a third occurrence is a red test, not a clean
     * report.
     */
    exclude: {
      path: '^(ui-prototype|tools/parity)(/|$)|^(\\.next|dist|coverage)(/|$)|^(apps|packages|modules|tools|tests)/[^/]+/(\\.next|dist|coverage)(/|$)',
    },
    tsConfig: { fileName: 'tsconfig.base.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      /*
       * The six runtime extensions, unchanged.
       *
       * A review flagged that `zod` — which resolves to `index.d.cts` —
       * produced no edges without declaration extensions here, and that any
       * future rule naming a types-first dependency would be inert in the
       * way `kysely-is-allowlisted` was. Tested against the exact pre-fix
       * config: it does not reproduce. `zod` resolves to
       * `node_modules/zod/index.d.cts` with these six and nothing else,
       * because `exportsFields` and the `types` condition give enhanced-
       * resolve an exact path, so the extension list is never consulted.
       * Adding `.d.ts`/`.d.cts`/`.d.mts`/`.cts`/`.mts`/`.json` changed the
       * graph by minus one module and zero dependencies, and gave no rule
       * any coverage it did not already have.
       *
       * Reverted rather than kept: config added on a theory that measurement
       * contradicts is how a file accumulates settings nobody can justify.
       * `tests/security/depcruise-negative-control.spec.ts` keeps a standing
       * assertion that a types-first dependency resolves, so a real
       * regression here is caught rather than argued about.
       */
      extensions: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
}
