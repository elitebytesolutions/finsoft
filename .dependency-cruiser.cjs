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
     * ADR-0028, M3-C's first PR (C2-C5). Module packaging and runtime.
     * ------------------------------------------------------------------ */
    {
      // C2. `no-cross-module-internals` above already forbids domain/ and
      // infrastructure/; this widens the same rule to the WHOLE of another
      // module — application/ and api/ included — leaving exactly one door
      // open: the other module's own application/published.ts.
      name: 'cross-module-via-published-only',
      severity: 'error',
      comment:
        'ADR-0028 statement 3 / C2: the only file reachable across modules/X -> modules/Y ' +
        '(Y != X) is modules/Y/application/published.ts. modules/receivables may not import ' +
        'modules/customers/application/create-customer.ts, or anything else of customers, only ' +
        'its published.ts.',
      from: { path: '^modules/([^/]+)/' },
      to: {
        path: '^modules/(?!$1/)[^/]+/',
        pathNot: '^modules/[^/]+/application/published\\.ts$',
      },
    },
    {
      // C3, first half. infrastructure/ implements application/ports.ts —
      // and reaches nothing else of application/ (no use case, no published
      // DTO reached through the back door).
      name: 'infrastructure-reaches-application-only-via-ports',
      severity: 'error',
      comment:
        'ADR-0028 statement 5: infrastructure/ -> application/ports.ts is the one sanctioned ' +
        'edge (a type-only import, so infrastructure/ can implement the port). Any other target ' +
        'under application/ — a use case, published.ts — is unreachable from infrastructure/.',
      from: { path: '^modules/([^/]+)/infrastructure/' },
      to: {
        path: '^modules/([^/]+)/application/',
        pathNot: '^modules/$1/application/ports\\.ts$',
      },
    },
    {
      // C3, second half. The infrastructure -> ports.ts edge above is
      // sanctioned only as a TYPE-only import — infrastructure/ implements
      // the port's interfaces, it does not call a runtime value ports.ts
      // exports (ports.ts declares none; a runtime dependency here would be
      // the domain-shaped coupling ADR-0028 statement 5 draws the line
      // against).
      name: 'ports-import-is-type-only',
      severity: 'error',
      comment:
        'ADR-0028 statement 5: modules/*/application/ports.ts is reached only as a type-only ' +
        'import. A runtime (value) import of ports.ts is not the "build a kernel payload" ' +
        'exception statement 5 grants for the kernel index — ports.ts has no runtime values to ' +
        'import in the first place.',
      from: {},
      to: {
        path: '^modules/([^/]+)/application/ports\\.ts$',
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      // C4, first third. application/ never reaches down into
      // infrastructure/ — a repository is handed to a use case, never
      // imported by one.
      name: 'application-does-not-import-infrastructure',
      severity: 'error',
      comment:
        'ADR-0028 statement 5: application/ never imports infrastructure/ — repositories are ' +
        'built by index.ts (the composition root) and passed in. A use case reaching down into ' +
        'infrastructure/ directly is exactly the coupling ports.ts exists to prevent.',
      from: { path: '^modules/([^/]+)/application/' },
      to: { path: '^modules/([^/]+)/infrastructure/' },
    },
    {
      // C4, second third. The module's OWN api/ layer (framework-free HTTP
      // contract: zod schemas, mappers, the error table) never imports
      // infrastructure/ either — same reason, a different layer.
      name: 'module-api-does-not-import-infrastructure',
      severity: 'error',
      comment:
        "ADR-0028 statement 4: a module's api/ layer is framework-free (zod request schemas, " +
        'response mappers, the error-code -> HTTP-status table) and never imports ' +
        'infrastructure/ — it has no business holding a repository.',
      from: { path: '^modules/([^/]+)/api/' },
      to: { path: '^modules/([^/]+)/infrastructure/' },
    },
    {
      // C4, third third. domain/ imports only its own files,
      // @finsoft/validation, @finsoft/shared-types, and the kernel index —
      // type-only. domain-is-pure (above) already forbids domain -> its own
      // module's api/application/infrastructure; this is the allow-list for
      // everything OUTSIDE the module.
      name: 'domain-imports-allowlisted',
      severity: 'error',
      comment:
        'ADR-0028 statement 5: domain/ imports only its own files, @finsoft/validation and ' +
        '@finsoft/shared-types outright, plus @finsoft/accounting-kernel type-only (to build a ' +
        "kernel payload, e.g. toSalePostedPayload()). Anything else — including the module's " +
        'own infrastructure/api/application, or a runtime import of the kernel — is forbidden. ' +
        'accounting-kernel is in this rule\'s allow-list (pathNot) so the TYPE-ONLY exception ' +
        'statement 5 grants is reachable at all — domain-kernel-import-is-type-only, below, is ' +
        'the rule that then rejects a non-type-only (runtime) import of it. Without ' +
        'accounting-kernel here, this rule alone forbade the path unconditionally and the other ' +
        'rule could never fire on anything this one had not already caught (Architecture seat ' +
        'Council review, 2026-09-29).',
      from: { path: '^modules/([^/]+)/domain/' },
      to: {
        pathNot: [
          '^modules/$1/domain/',
          '^packages/(validation|shared-types|accounting-kernel)/',
          '^node_modules/',
        ],
      },
    },
    {
      // C4, third third, continued: the ONE exception (kernel index,
      // type-only) stated as its own rule, since "pathNot" above excludes
      // the kernel unconditionally rather than conditionally on
      // dependencyType. A value (runtime) import of the kernel from
      // domain/ must still fail — domain/ may look at the kernel's TYPES
      // only, never call one of its functions.
      name: 'domain-kernel-import-is-type-only',
      severity: 'error',
      comment:
        'ADR-0028 statement 5: domain/ may import @finsoft/accounting-kernel type-only (to type ' +
        'a payload it builds, e.g. toSalePostedPayload()). A runtime import — calling ' +
        'postingEngine.post or registerParty from domain/ — belongs in application/, not here.',
      from: { path: '^modules/([^/]+)/domain/' },
      to: {
        path: '^packages/accounting-kernel/',
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      // C5, first half. apps/** reaches a module only through its index.ts
      // — never domain/, application/, infrastructure/ or api/ directly.
      name: 'apps-import-module-index-only',
      severity: 'error',
      comment:
        'ADR-0028 statement 3: apps/api, apps/worker and tests/** reach a module through ".' +
        '" -> ./index.ts alone. apps/** importing modules/customers/application/create-customer.ts ' +
        'directly, instead of the factory index.ts exports, is the same private-internals ' +
        'violation no-cross-module-internals forbids between two modules.',
      from: { path: '^apps/' },
      to: {
        path: '^modules/',
        pathNot: '^modules/[^/]+/index\\.ts$',
      },
    },
    {
      // C5, second half. A module never imports auth, permissions, ui, an
      // app, or packages/database's auth query surface.
      name: 'modules-import-allowlisted',
      severity: 'error',
      comment:
        'ADR-0028 statement 5: a module may import the kernels’ public index, ' +
        '@finsoft/database (root only), @finsoft/validation, @finsoft/shared-types, ' +
        '@finsoft/reporting and @finsoft/observability (not in domain/). It never imports ' +
        '@finsoft/auth, @finsoft/permissions, @finsoft/ui, an app, or packages/database’s ' +
        'auth/login query surface.',
      from: { path: '^modules/' },
      to: {
        path: ['^packages/(auth|permissions|ui)/', '^apps/', '^packages/database/src/auth/'],
      },
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
        'packages/database and nowhere else. tools/db/outbox-plan.mjs is the one named ' +
        'exception (M1-X, Council S3 widened depcruise to tools/): a standalone benchmarking ' +
        'script, reviewed and already documented in its own header as writing to the ' +
        'disposable TEST database only, run manually via npm run db:outbox-plan — never part ' +
        'of the running application or a package another module imports.',
      from: { pathNot: ['^packages/database/', '^tools/db/outbox-plan\\.mjs$'] },
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
     * M1-X, Security seat final check on a7576ac (item 3, "close it rather
     * than defer"). eslint.config.mjs's no-restricted-imports bans
     * @finsoft/database/testing, /provisioning and /request-scope by NAME —
     * but that rule matches the import specifier as written, and neither a
     * dynamic `import('@finsoft/database/testing')` (a template-literal or
     * otherwise non-static specifier defeats the AST-level name match) nor
     * a relative path reaching the SAME FILE from underneath
     * (`../../../packages/database/src/testing/harness.ts`, which never
     * names the package specifier at all) is caught by it. dependency-
     * cruiser watches the RESOLVED module graph instead: it does not care
     * how an edge was spelled, only which file it ends up pointing at, so
     * these three rules close exactly the gap the ESLint rules cannot.
     *
     * package.json's own "exports" map already makes a deep bare-specifier
     * path (`@finsoft/database/src/testing/harness.ts`,
     * `@finsoft/database/testing/harness.ts`) unresolvable — Node's exports
     * field is exclusive by default, with no wildcard entry here that would
     * reopen it, so nothing there needed tightening. The gap was never in
     * how the package is entered; it was in the module graph having no
     * rule watching the destination file itself, regardless of entry path.
     * ------------------------------------------------------------------ */
    {
      name: 'no-testing-outside-database',
      severity: 'error',
      comment:
        'M1-X, Council re-review 1 / Security seat final check 3: @finsoft/database/testing ' +
        '(runAs — TenantContext.run with any caller-supplied principal) is a Vitest fixture ' +
        'helper, reachable only from inside packages/database itself. Every other importer — ' +
        'including one reaching the same file by a relative path or a dynamic import, which ' +
        "ESLint's own name-based ban does not see — is a real request or job path acquiring " +
        'the power to become any tenant on demand.',
      from: { pathNot: '^packages/database/' },
      to: { path: '^packages/database/src/testing/' },
    },
    {
      name: 'no-provisioning-outside-owners',
      severity: 'error',
      comment:
        'M1-X, Council re-review 1 / Security seat final check 3: @finsoft/database/' +
        'provisioning (sets tenant context from a caller-supplied tenantId; creates ACTIVE ' +
        "users with role grants; writes no audit row — see the file's own header) is " +
        'reachable only from inside packages/database itself or tools/seed/** (the demo seed ' +
        'script today; the M2 backfill CLI, tools/seed/backfill-accounting.mjs, when it ' +
        'lands). Every other importer, by any path, is onboarding a real account with ' +
        'nothing to show for it in the audit trail.',
      from: { pathNot: ['^packages/database/', '^tools/seed/'] },
      to: { path: '^packages/database/src/provisioning\\.ts$' },
    },
    {
      name: 'no-request-scope-outside-guard',
      severity: 'error',
      comment:
        "M1-X, Council T1 / Security seat final check 3: @finsoft/database/request-scope's " +
        'withTenantAsPrincipal opens a guard-scoped TenantContext for exactly one caller — ' +
        'PermissionGuard, which runs before the request-wide TenantContextInterceptor has had ' +
        'a chance to. Reachable only from inside packages/database itself or ' +
        'apps/api/src/common/permission.guard.ts, by any path.',
      from: {
        pathNot: ['^packages/database/', '^apps/api/src/common/permission\\.guard\\.ts$'],
      },
      to: { path: '^packages/database/src/request-scope\\.ts$' },
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
     * `tests/security/depcruise-negative-control.spec.ts` fails if either rule stops
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
