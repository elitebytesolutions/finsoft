import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import prettier from 'eslint-config-prettier'

/*
 * FinSoft lint configuration.
 *
 * Most of what is here is not style. It is the mechanical half of the ADRs:
 * each block below cites the document it enforces. Formatting is Prettier's
 * job and is switched off here via eslint-config-prettier.
 *
 * Import boundaries between packages are dependency-cruiser's job
 * (.dependency-cruiser.cjs). This file handles rules that need to look at
 * syntax rather than at the module graph.
 */

/** Decimal libraries. ADR-0011 / ADR-0014: exactly one, only in packages/validation. */
const DECIMAL_LIBS = ['decimal.js', 'decimal.js-light', 'big.js', 'bignumber.js']

/** Network clients. ADR-0001: the kernels have no network. */
const HTTP_CLIENTS = ['axios', 'node-fetch', 'undici', 'got', 'superagent', 'ky']

/** ADR-0012: fiscal period locking has no system bypass, so these names may not exist. */
const PERIOD_BYPASS = ['bypassPeriod', 'skipPeriodCheck', 'forcePost', 'systemActor']

const invariantSyntax = [
  {
    // ADR-0013. A numeric or int8 parser override silently destroys ADR-0011.
    selector: "CallExpression[callee.property.name='setTypeParser']",
    message:
      'ADR-0013: type parser overrides are forbidden. numeric and int8 must reach TypeScript as strings.',
  },
  {
    // ADR-0013. pg.defaults.parseInt8 = true rewires OID 20 without touching setTypeParser.
    selector: "MemberExpression[object.name='pg'][property.name='defaults']",
    message: 'ADR-0013: pg.defaults is forbidden — it can rewire type parsing behind the ADR.',
  },
  {
    // ADR-0013. sql.raw does not parameterise, unlike the sql tag it hides behind.
    selector: "CallExpression[callee.object.name='sql'][callee.property.name='raw']",
    message: 'ADR-0013: sql.raw does not parameterise. Use the sql tag, or an allowlisted helper.',
  },
  {
    /*
     * ADR-0013. DDL lives in database/migrations/*.sql, never in TypeScript.
     *
     * Matched on the DDL method rather than on the receiver's name. An
     * earlier version keyed on identifiers called db/tx/trx/kysely, which
     * `fullDb().schema.createTable(...)` walks straight past.
     */
    selector:
      "MemberExpression[object.property.name='schema'][property.name=/^(createTable|alterTable|dropTable|createIndex|dropIndex|createType|dropType|createView|dropView|createSchema|dropSchema)$/]",
    message: 'ADR-0013: DDL belongs in database/migrations/*.sql, not in a Kysely schema builder.',
  },
  {
    /*
     * Kysely's `sql` tag parameterises; these three do not, and all three are
     * reachable through the tag the lint rule blesses.
     */
    selector: "CallExpression[callee.object.name='sql'][callee.property.name=/^(lit|id)$/]",
    message:
      'ADR-0013: sql.lit and sql.id do not parameterise. Allowlist-only, and they need review.',
  },
  {
    /*
     * ADR-0013 + ADR-0004:140. clearWhere strips the predicates the base
     * repository just added. On scopedUpdate that is the tenant predicate AND
     * the id and version predicates, producing an unbounded tenant-wide
     * UPDATE with the optimistic lock removed. RLS backstops the tenant half;
     * nothing backstops the rest.
     */
    selector: 'CallExpression[callee.property.name=/^(clearWhere|clearSelect|clearLimit)$/]',
    message:
      'Stripping a query clause discards the tenant, id and version predicates the base ' +
      'repository added. Build a new query instead.',
  },
  {
    // ADR-0013: the bare-call form, which the receiver-based rule below misses.
    selector: "CallExpression[callee.name='setTypeParser']",
    message:
      'ADR-0013: type parser overrides are forbidden in any import form. numeric and int8 ' +
      'must reach TypeScript as strings.',
  },
  {
    selector: "NewExpression[callee.name='Migrator']",
    message: "ADR-0013: Kysely's Migrator is not used. Migrations are numbered .sql files.",
  },
  {
    /*
     * ADR-0014. The configured constructor is frozen; reconfiguring it is
     * retroactive and invisible.
     *
     * This name list is the second line of defence, not the first. The first
     * is the import ban below plus the dependency-cruiser rule: a decimal
     * constructor binding cannot exist outside packages/validation at all.
     * Keep FinDecimal here — it is the name the real binding uses, and an
     * earlier version of this list omitted it.
     */
    selector:
      "CallExpression[callee.property.name='set'][callee.object.name=/^(FinDecimal|Decimal|Big|BigNumber|D|M)$/]",
    message:
      'ADR-0014: decimal configuration exists at exactly one frozen clone site in packages/validation.',
  },
  {
    // ADR-0012. Named in the ADR's own compliance section as a code-search check.
    selector: `Identifier[name=/^(${PERIOD_BYPASS.join('|')})$/]`,
    message:
      'ADR-0012: a closed period rejects postings from jobs, imports and scripts alike. There is no bypass.',
  },
  {
    // AGENTS.md rule 4 / anti-pattern 6. A red test is information, not an obstacle.
    selector: "MemberExpression[object.name=/^(it|test|describe)$/][property.name='skip']",
    message: 'AGENTS.md rule 4: never disable a test to reach green. Report the failure instead.',
  },
  {
    // .only silently reduces a suite to one case while still reporting success.
    selector: "MemberExpression[object.name=/^(it|test|describe)$/][property.name='only']",
    message: '.only silently skips the rest of the suite. Remove it before committing.',
  },
]

/**
 * Connection ownership. ADR-0013, and ADR-0004's Compliance section.
 *
 * Held separately from `invariantSyntax` because ESLint REPLACES a rule's
 * configuration rather than merging it: a later block setting
 * no-restricted-syntax silently drops every selector an earlier block
 * declared. Both the "outside packages/database" block and the "apps/**"
 * block need these, so they are composed into each rather than written twice
 * and drifting apart.
 */
/*
 * Node's native type stripping ERASES types; it does not TRANSFORM. Anything
 * needing a transformation cannot be loaded by the runtime that ships.
 *
 * Declared as an array rather than inline because ESLint flat config REPLACES
 * a rule's options between blocks instead of merging them. Inline, these
 * three selectors were silently dropped for every package except
 * packages/database — see the block that composes them below.
 */
/*
 * apps/ * build no queries. ADR-0013's second import boundary.
 *
 * Named, like the others, so it can be COMPOSED into the worker's block
 * below instead of being replaced by it.
 */
const appsQuerySyntax = [
  {
    selector:
      'CallExpression[callee.property.name=/^(selectFrom|insertInto|updateTable|deleteFrom|replaceInto|with)$/]',
    message:
      'ARCHITECTURE §5 / ADR-0013: apps/** contains no query construction. Receiving a ' +
      'transaction handle through a callback does not make this the data layer. Put the ' +
      'query behind a named export in packages/database and call that.',
  },
]

const stripOnlySyntax = [
  {
    selector: 'TSParameterProperty',
    message:
      'Node strip-only mode cannot load a parameter property. Declare the field and ' +
      'assign it in the constructor body — packages/** is executed as TypeScript.',
  },
  {
    selector: 'TSEnumDeclaration',
    message:
      'Node strip-only mode cannot load an enum. Use a const object with `as const` ' +
      'and a derived union type.',
  },
  {
    selector: 'TSModuleDeclaration[kind="namespace"]',
    message: 'Node strip-only mode cannot load a namespace. Use a module.',
  },
]

const connectionOwnershipSyntax = [
  {
    selector: 'CallExpression[callee.property.name=/^(transaction|startTransaction|connection)$/]',
    message:
      'ADR-0013: transactions are opened only in packages/database. Use withTenant or ' +
      'withGlobal — a bare transaction has no app.tenant_id set, and RLS will refuse it.',
  },
  {
    /*
     * ADR-0004's Compliance section requires this and it did not exist. The
     * wrapper in packages/database is the only code that may set the tenant,
     * and it takes it from the verified JWT claim — never from a request.
     */
    selector: 'Literal[value=/app\\.tenant_id/]',
    message:
      'ADR-0004: packages/database is the only code that sets app.tenant_id. Setting it ' +
      'elsewhere is how a tenant ends up taken from a request instead of a verified claim.',
  },
  {
    /*
     * The SAME rule for a template literal, which is the form the codebase
     * itself uses.
     *
     * A template literal's text is a TemplateElement, not a Literal, so the
     * selector above missed:
     *
     *   sql`select set_config('app.tenant_id', ${t}, true)`
     *
     * That is character-for-character the shape of the sanctioned
     * implementation in packages/database, and therefore exactly what
     * someone copying it would write. The harness only ever exercised the
     * double-quoted form, so it certified a rule that missed the realistic
     * case.
     */
    selector: 'TemplateElement[value.raw=/app\\.tenant_id/]',
    message:
      'ADR-0004: packages/database is the only code that sets app.tenant_id — including ' +
      'inside a template literal or an sql`` tag. Setting it elsewhere is how a tenant ends ' +
      'up taken from a request instead of a verified claim.',
  },
  {
    /*
     * `<TenantTx>x`, the angle-bracket form. The TSAsExpression selector
     * below catches `x as TenantTx` and not this one. The runtime WeakSet
     * registry rejects a forged handle at the point of use either way; this
     * catches it at build time, which is where a boundary violation belongs.
     */
    selector: 'TSTypeAssertion[typeAnnotation.typeName.name=/^(TenantTx|GlobalTx)$/]',
    message:
      'ADR-0013: a transaction handle is issued by withTenant or withGlobal, never asserted ' +
      'into existence. The runtime registry will reject a forged handle.',
  },
  {
    selector: 'TSAsExpression[typeAnnotation.typeName.name=/^(TenantTx|GlobalTx)$/]',
    message:
      'ADR-0013: a brand is forgeable with `as`. Obtain the handle from withTenant or ' +
      'withGlobal — they are the only issuers, and the runtime registry checks it.',
  },
]

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/coverage/**',
      'ui-prototype/**',
      'packages/database/src/generated/**',
      'tools/parity/**',
      // Generated by Next and gitignored; not ours to lint.
      '**/next-env.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  /* ---------------------------------------------------------------- *
   * Repository-wide invariants
   * ---------------------------------------------------------------- */
  {
    rules: {
      'no-restricted-syntax': ['error', ...invariantSyntax],
      'no-restricted-imports': [
        'error',
        {
          paths: DECIMAL_LIBS.map((name) => ({
            name,
            message:
              'ADR-0011/ADR-0014: import Money from @finsoft/validation. The decimal library lives there and nowhere else.',
          })),
        },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  /* ---------------------------------------------------------------- *
   * packages/** must stay loadable by Node's type stripping
   *
   * These packages ship TypeScript source and are executed directly — the
   * migration CLI runs `node packages/database/src/migrate/cli.ts`, and
   * apps/api requires the package at runtime. Node strips types; it does
   * not transform. A construct that needs transforming makes the module
   * unloadable.
   *
   * This is invisible to the test suite, because Vitest transpiles. A
   * parameter property in BaseRepository passed every test while the module
   * could not be loaded by Node at all, and only surfaced when apps/api
   * first required it.
   *
   * apps/** is exempt: apps/api builds with SWC, and NestJS dependency
   * injection depends on parameter properties.
   * ---------------------------------------------------------------- */
  {
    files: ['packages/*/src/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...invariantSyntax, ...stripOnlySyntax],
    },
  },

  /* ---------------------------------------------------------------- *
   * Connection ownership. ADR-0013 and ADR-0004's Compliance section.
   *
   * ADR-0004 is Accepted and LEVEL 1, and it requires that
   * set_config('app.tenant_id', …) appear only in packages/database —
   * "anywhere else fails the build". That rule did not exist. Neither did
   * ADR-0013's rules confining transaction creation and forbidding a type
   * assertion to the branded handle.
   *
   * The branded handle plus the runtime WeakSet registry catch a forged
   * handle at the moment it is used; these catch it at build time, which is
   * where a boundary violation should be caught.
   * ---------------------------------------------------------------- */
  {
    files: ['**/*.ts', '**/*.tsx'],
    ignores: [
      'packages/database/**',
      /*
       * The suites that exist to VERIFY these controls have to be able to
       * name them. tests/security asserts that a reused connection carries no
       * app.tenant_id, and deliberately forges a handle with `as TenantTx` to
       * prove the runtime registry rejects it; database/tests reads the GUC
       * from the catalog. A rule that forbade its own verification would be
       * weakened rather than obeyed.
       *
       * Both directories contain tests only, so this exempts no production
       * code. The narrower alternative — an inline disable on each of the
       * twelve occurrences — buries the reasoning in twelve places.
       */
      'tests/security/**',
      'database/tests/**',
    ],
    rules: {
      'no-restricted-syntax': ['error', ...invariantSyntax, ...connectionOwnershipSyntax],
    },
  },

  /* ---------------------------------------------------------------- *
   * Strip-only safety, RESTORED.
   *
   * The block above sets `no-restricted-syntax` for every TypeScript file,
   * and ESLint flat config REPLACES a rule's options rather than merging
   * them. That silently
   * discarded the three strip-only selectors for every package except
   * packages/database — which survived only because it is in that block's
   * `ignores`.
   *
   * The consequence was not theoretical. `apps/worker` runs
   * `node apps/worker/src/main.ts` directly under type stripping IN
   * PRODUCTION, and `packages/validation` is loaded the same way by
   * apps/api. An enum or a parameter property in either would compile, lint
   * clean, pass every Vitest run — Vitest transpiles — and fail only when the
   * runtime that ships first loaded the module. That is exactly how a
   * parameter property in BaseRepository survived 200 tests.
   *
   * Composed, not replaced: this block restates all three arrays, because
   * restating only the strip-only ones would drop the other two in turn —
   * the same trap, one block later.
   *
   * apps/api is deliberately NOT here. It builds with SWC because NestJS
   * dependency injection needs emitDecoratorMetadata and parameter
   * properties, which is why its tsconfig does not extend
   * tsconfig.packages.json.
   * ---------------------------------------------------------------- */
  {
    files: ['packages/*/src/**/*.ts', 'apps/worker/src/**/*.ts'],
    /*
     * packages/database keeps the configuration it gets earlier: invariant +
     * strip-only, and deliberately NOT connection ownership, because it is
     * the package that owns connections.
     */
    ignores: ['packages/database/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...invariantSyntax,
        ...connectionOwnershipSyntax,
        ...stripOnlySyntax,
      ],
    },
  },

  /* ---------------------------------------------------------------- *
   * apps/** build no queries. ADR-0013's "two import boundaries".
   *
   * dependency-cruiser watches the module graph, and a transaction handle
   * arrives through a CALLBACK rather than an import — so `tx.selectFrom(…)`
   * inside a controller reads as ordinary application code and nothing
   * objected. That is exactly how the readiness probe came to build queries
   * in the HTTP layer.
   *
   * A health check is the most copied file in a codebase. Left alone it would
   * have given every Wave 1 controller a worked example of the thing the
   * boundary exists to prevent.
   * ---------------------------------------------------------------- */
  {
    files: ['apps/**/*.ts', 'apps/**/*.tsx'],
    ignores: ['apps/**/*.spec.ts', 'apps/**/*.test.ts', 'apps/worker/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...invariantSyntax,
        ...connectionOwnershipSyntax,
        ...appsQuerySyntax,
      ],
    },
  },

  /* ---------------------------------------------------------------- *
   * apps/worker — everything the block above applies, PLUS strip-only.
   *
   * Split out rather than folded in, because the two apps are compiled
   * differently and the difference is load-bearing:
   *
   *   apps/api     built with SWC, because NestJS dependency injection
   *                needs emitDecoratorMetadata and parameter properties.
   *                Strip-only rules must NOT apply.
   *   apps/worker  no build at all. Production runs
   *                `node apps/worker/src/main.ts` directly under Node's
   *                native type stripping, exactly as packages/ * do.
   *
   * Without this the worker had no strip-only protection whatsoever: an
   * enum or a parameter property in it would compile, lint clean, pass
   * every Vitest run — Vitest transpiles — and fail only when the
   * container first loaded the module.
   * ---------------------------------------------------------------- */
  {
    files: ['apps/worker/src/**/*.ts'],
    ignores: ['apps/worker/**/*.spec.ts', 'apps/worker/**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...invariantSyntax,
        ...connectionOwnershipSyntax,
        ...appsQuerySyntax,
        ...stripOnlySyntax,
      ],
    },
  },

  /* ---------------------------------------------------------------- *
   * packages/validation — the one place a decimal library may live
   * ADR-0011, ADR-0014
   * ---------------------------------------------------------------- */
  {
    files: ['packages/validation/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },

  /* ---------------------------------------------------------------- *
   * The kernels — no network, no HTTP, no NestJS, no feature modules
   * ADR-0001, ADR-0005, ARCHITECTURE.md §5
   * ---------------------------------------------------------------- */
  {
    files: ['packages/accounting-kernel/**/*.ts', 'packages/inventory-kernel/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'ADR-0001: the kernels have no network.' },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...DECIMAL_LIBS.map((name) => ({
              name,
              message: 'ADR-0011: import Money from @finsoft/validation.',
            })),
            ...HTTP_CLIENTS.map((name) => ({
              name,
              message: 'ADR-0001: the kernels have no network.',
            })),
            {
              name: '@nestjs/common',
              message: 'ARCHITECTURE §3: the kernels know nothing about HTTP or NestJS.',
            },
          ],
          patterns: [
            {
              group: [
                '**/modules/**',
                '@finsoft/reporting',
                '@finsoft/auth',
                '@finsoft/permissions',
              ],
              message:
                'ARCHITECTURE §5: a kernel imports database, validation and shared-types — and nothing else.',
            },
          ],
        },
      ],
    },
  },

  /* ---------------------------------------------------------------- *
   * Module domain layers — pure TypeScript
   * ARCHITECTURE.md §2: "no NestJS, no ORM, no HTTP"
   * ---------------------------------------------------------------- */
  {
    files: ['modules/*/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'kysely', message: 'ARCHITECTURE §2: domain/ is pure TypeScript — no ORM.' },
            { name: 'pg', message: 'ARCHITECTURE §2: domain/ is pure TypeScript — no driver.' },
            {
              name: '@finsoft/database',
              message: 'ARCHITECTURE §2: domain/ never sees a connection or a row type.',
            },
            ...DECIMAL_LIBS.map((name) => ({
              name,
              message: 'ADR-0011: import Money from @finsoft/validation.',
            })),
          ],
          patterns: [
            {
              group: ['@nestjs/*', 'express', 'fastify'],
              message: 'ARCHITECTURE §2: domain/ has no HTTP and no framework.',
            },
          ],
        },
      ],
    },
  },

  /* ---------------------------------------------------------------- *
   * apps/web — UI only, no business rules
   * NON_NEGOTIABLES rule 19, ARCHITECTURE.md §5
   * ---------------------------------------------------------------- */
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...DECIMAL_LIBS.map((name) => ({
              name,
              message: 'Rule 19: the browser never computes a monetary figure.',
            })),
            {
              name: '@finsoft/accounting-kernel',
              message: 'Rule 19: business logic lives in the backend domain layer, never in React.',
            },
            {
              name: '@finsoft/inventory-kernel',
              message: 'Rule 19: business logic lives in the backend domain layer, never in React.',
            },
            {
              name: '@finsoft/database',
              message: 'ARCHITECTURE §5: apps/web reaches ui, shared-types and validation only.',
            },
            { name: 'kysely', message: 'ARCHITECTURE §5: the browser has no database.' },
            { name: 'pg', message: 'ARCHITECTURE §5: the browser has no database.' },
          ],
          patterns: [
            {
              group: ['**/modules/*/domain/**', '**/modules/*/application/**'],
              message: 'ARCHITECTURE §5: apps/web never reaches into a module.',
            },
          ],
        },
      ],
    },
  },

  /* ---------------------------------------------------------------- *
   * React. apps/web is the only React surface; the hooks rules are here
   * because a lint setup that cannot resolve this app's own
   * eslint-disable directives is not a working lint setup.
   * ---------------------------------------------------------------- */
  {
    files: ['apps/web/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  /* ---------------------------------------------------------------- *
   * Config files and scripts
   * ---------------------------------------------------------------- */
  {
    files: ['*.config.{js,mjs,ts}', 'tools/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        __dirname: 'readonly',
        setTimeout: 'readonly',
      },
    },
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { module: 'writable', require: 'readonly', __dirname: 'readonly' },
    },
    rules: { 'no-console': 'off' },
  },

  /* ---------------------------------------------------------------- *
   * Long-running services log through @finsoft/observability, never
   * through console. ADR-0016, INFRASTRUCTURE.md §8.
   *
   * The global rule allows console.warn and console.error. That is right
   * for scripts and wrong here: a bare console.error writes UNSTRUCTURED
   * text to the same stdout the JSON log pipeline reads, so the
   * aggregator gets a line it cannot parse, with no level, no
   * correlation id and no redaction. The one thing it is guaranteed to
   * carry is whatever the developer interpolated into it — which is how
   * rule 20 gets broken by someone who was only debugging.
   *
   * No allowances, so the sole escape is a scoped disable with a stated
   * reason. There is exactly one legitimate case: a startup failure
   * before initLogger() has run, where the alternative is a process that
   * exits silently into a crash loop.
   * ---------------------------------------------------------------- */
  {
    files: [
      'apps/api/src/**/*.ts',
      'apps/worker/src/**/*.ts',
      'modules/**/*.ts',
      /*
       * The five packages ADR-0016 §2 rules on. They MAY log — a connection
       * pool that cannot report a failed connection is worse than one that
       * can — but only through @finsoft/observability.
       *
       * Added because §2 said "never via `console`" while nothing implemented
       * it: for `packages/**` the repo-wide rule stood, so `console.error`
       * was legal and `console.log` was a warning, and the ADR's own named
       * first consumer used it. A boundary stated in a LEVEL 1 record with no
       * mechanism is the failure this reconciliation exists to remove.
       *
       * `packages/database/src/generate` and `migrate` are not carved out
       * here: the `cli.ts` override above already covers the entrypoints, and
       * the library code beneath them has no business printing.
       */
      'packages/database/src/**/*.ts',
      'packages/auth/src/**/*.ts',
      'packages/permissions/src/**/*.ts',
      'packages/reporting/src/**/*.ts',
      'packages/validation/src/**/*.ts',
    ],
    /*
     * The full array, not the bare severity. Passing `'error'` alone raises
     * the severity and KEEPS the options from the earlier block, so
     * `allow: ['warn', 'error']` survives and console.error stays legal —
     * the rule reads as tightened and enforces nothing new.
     *
     * `{}` rather than `{ allow: [] }`: the rule's own schema requires
     * `allow` to have at least one item, so an empty array is rejected
     * outright. An empty options OBJECT is what clears the inherited ones.
     */
    rules: { 'no-console': ['error', {}] },
  },

  /* ---------------------------------------------------------------- *
   * The two carve-outs, and they must come LAST.
   *
   * Flat config REPLACES rule options between blocks rather than merging
   * them, and the later block wins. These sat BEFORE the service block
   * above, so extending that block to packages/** silently re-banned
   * console in all three CLIs — 23 errors in files whose entire job is to
   * print. Order is the mechanism here, not decoration.
   * ---------------------------------------------------------------- */
  {
    /*
     * CLI entrypoints. A command-line tool's output IS stdout, so the file
     * that legitimately owns the thing no-console bans gets a scoped
     * override rather than fourteen inline disables.
     *
     * Narrow on purpose: only cli.ts, not the modules it calls. Library code
     * still has no business printing.
     */
    files: ['packages/*/src/**/cli.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    /*
     * A test that asserts on what reached stdout has to be able to name
     * `console` — `guards.test.ts` replaces `console.error` to prove the
     * pool's error listener redacts the password out of a driver message.
     * Banning it there would ban the test that proves the ban matters.
     *
     * Scoped to test files only. This is not a general exemption for test
     * code: everything else in the ruleset still applies to it, including
     * the decimal-library and tenant-predicate rules, which is the whole
     * reason the restricted-import rules are repo-wide.
     */
    files: ['**/*.test.ts', '**/*.spec.ts'],
    rules: { 'no-console': 'off' },
  },

  prettier,
)
