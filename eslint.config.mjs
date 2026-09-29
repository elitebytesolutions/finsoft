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

const DECIMAL_LIB_IMPORT_PATHS = DECIMAL_LIBS.map((name) => ({
  name,
  message:
    'ADR-0011/ADR-0014: import Money from @finsoft/validation. The decimal library lives there and nowhere else.',
}))

/*
 * M1-X, Council T1 (Architecture R1 / Security 1 / Database C1).
 * withTenantAsPrincipal lives at its own narrow subpath,
 * @finsoft/database/request-scope, and is importable ONLY from
 * apps/api/src/common/permission.guard.ts — the one caller it exists for
 * (a NestJS GUARD, which runs strictly before any interceptor and so cannot
 * rely on the request-wide TenantContextInterceptor having run yet).
 */
const REQUEST_SCOPE_IMPORT_BAN = {
  name: '@finsoft/database/request-scope',
  message:
    'M1-X T1: withTenantAsPrincipal may be imported only from ' +
    'apps/api/src/common/permission.guard.ts.',
}

/*
 * M1-X, Council T2 (Architecture R2 / Security 1). Replaces the earlier
 * call-pattern rule (`TenantContext.run(...)`), which an aliased import
 * (`import { TenantContext as T }`), a namespace access
 * (`TenantContext['run']`) or a destructure (`const { run } = TenantContext`)
 * all walk straight past — every one of those still requires the IMPORT,
 * which this rule catches regardless of how the code goes on to use it.
 * `importNames` matches the imported name, not the local binding, so
 * aliasing does not evade it either.
 *
 * Confined to the request-scoping interceptor,
 * apps/worker/src/outbox/dispatcher.ts (Council re-review Arch R2: the
 * SPECIFIC worker file that needs it, not the whole app — the outbox
 * dispatcher opens a TenantContext per row it replays, since each row names
 * a different tenant and there is no request to inherit one from; no other
 * job in apps/worker does this today), packages/database and packages/auth
 * — everywhere else establishes tenant scope through one of those instead of
 * importing TenantContext to do it locally.
 */
const TENANT_CONTEXT_IMPORT_BAN = {
  name: '@finsoft/database',
  importNames: ['TenantContext'],
  message:
    'M1-X T2: TenantContext may be imported only by the request-scoping interceptor ' +
    '(apps/api/src/common/tenant-context.interceptor.ts), ' +
    'apps/worker/src/outbox/dispatcher.ts, packages/database and packages/auth. Establish ' +
    'tenant scope through one of those instead of importing it here.',
}

/*
 * M1-X, Council re-review item 1 (Security F1 / Database C5).
 * `runAs` (`@finsoft/database/testing`) is `TenantContext.run` with ANY
 * principal a caller supplies — no less powerful than the real thing, built
 * for fixtures that need to become a specific tenant/user on demand, never
 * for a real request or job path. Importable only from a test file.
 */
const TESTING_IMPORT_BAN = {
  name: '@finsoft/database/testing',
  message:
    'M1-X Council re-review 1: @finsoft/database/testing (runAs = TenantContext.run with any ' +
    'caller-supplied principal) is a Vitest fixture helper against the TEST database, ' +
    'importable only from a test file — never from application code.',
}

/*
 * M1-X, Council re-review item 1 (Security F1 / Database C5).
 * `@finsoft/database/provisioning` sets tenant context from a caller-supplied
 * tenantId and creates ACTIVE users with role grants — and, by that file's
 * own header, writes NO audit row. Its one legitimate non-test caller is
 * tools/seed/** (the demo seed script today; the M2 backfill CLI,
 * tools/seed/backfill-accounting.mjs, when it lands). Anywhere else, calling
 * it would create or grant a real account with nothing to show for it in
 * the audit trail.
 */
const PROVISIONING_IMPORT_BAN = {
  name: '@finsoft/database/provisioning',
  message:
    'M1-X Council re-review 1: @finsoft/database/provisioning writes no audit row and is ' +
    'importable only from tools/seed/** or a test file — never from application code.',
}

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

/*
 * packages/auth builds no queries either. ADR-0023 (M1-A): the Architecture
 * seat ruled that ALL query construction for login/refresh stays in
 * packages/database, and packages/auth is not on ADR-0013's kysely
 * allowlist (.dependency-cruiser.cjs `kysely-is-allowlisted`) — so it must
 * never receive a transaction handle and build a query on it.
 *
 * dependency-cruiser cannot see this class of violation: a handle arrives
 * through a CALLBACK from a `@finsoft/database` export, not an import of
 * `kysely` or `pg`, so the module graph looks clean either way. This is the
 * same gap `appsQuerySyntax` above exists to close for apps/**, applied to
 * the one package where an auth-shaped "just read the row here" temptation
 * is realistic. A separate array (not a reuse of `appsQuerySyntax`) so its
 * message names the right boundary instead of pointing someone at apps/**.
 */
const packagesAuthQuerySyntax = [
  {
    selector:
      'CallExpression[callee.property.name=/^(selectFrom|insertInto|updateTable|deleteFrom|replaceInto|with)$/]',
    message:
      "ADR-0023: packages/auth/** contains no query construction. It is not on ADR-0013's " +
      'kysely allowlist. A transaction handle received through a callback from ' +
      '@finsoft/database is not an import dependency-cruiser can see — put the query behind a ' +
      'named export in packages/database and call that.',
  },
]

/*
 * packages/accounting-kernel: query construction only in src/queries/**.
 * M2-A. The kernel legitimately builds queries — ADR-0005 puts the
 * journal_entries / journal_lines writes inside it, and ADR-0026 statement 5
 * (Architecture-seat correction) puts the `parties` INSERT inside it rather
 * than in packages/database, which modules may import. So the rule is not
 * "no queries in the kernel" (an earlier draft of this rule said that, and
 * contradicted ADR-0026): it is "query bodies live in dedicated files under
 * packages/accounting-kernel/src/queries/, and the posting pipeline, the
 * reversal engine and the rules contain none". Same callback-handle gap as
 * apps/** and packages/auth: dependency-cruiser cannot see
 * `tx.insertInto(...)` on a handle that arrived as a parameter, nor an sql``
 * tag.
 */
const accountingKernelLogicQuerySyntax = [
  {
    selector:
      'CallExpression[callee.property.name=/^(selectFrom|selectNoFrom|insertInto|updateTable|deleteFrom|replaceInto|mergeInto|with|executeQuery)$/]',
    message:
      'ADR-0005 / ADR-0026 (M2-A): packages/accounting-kernel keeps its query bodies in ' +
      'src/queries/**. Posting-pipeline, reversal and rule files call those functions (or ' +
      'packages/database reads) and construct no query themselves.',
  },
  {
    selector: "TaggedTemplateExpression[tag.name='sql']",
    message:
      'ADR-0005 / ADR-0026 (M2-A): packages/accounting-kernel keeps its query bodies in ' +
      'src/queries/**. An sql`` tag outside it is query construction in business logic.',
  },
]

/*
 * No transaction control in the kernel. ADR-0027 (partial supersession of
 * ADR-0005 step 2), merge condition K1.
 *
 * The kernel runs INSIDE the caller's transaction (postingEngine.post(cmd,
 * tx)); it never begins, commits, rolls back or reconfigures one. A COMMIT
 * issued from the kernel would make a posting durable before the caller's
 * own writes — the document, the subledger, the audit record — and a ROLLBACK
 * would silently discard them. ADR-0027 sanctions exactly ONE exception: the
 * named savepoint `finsoft_posting_number` that brackets numbering + the
 * entry INSERT, in src/queries/journal-writes.ts, as the three whole
 * statements `SAVEPOINT finsoft_posting_number`, `RELEASE SAVEPOINT
 * finsoft_posting_number` and `ROLLBACK TO SAVEPOINT finsoft_posting_number`.
 * Any other savepoint name, a dynamic name, or a second statement appended to
 * an allowed one is an error, even in that file.
 *
 * Caught as: the text of any template literal (sql`` tagged or not, which
 * covers sql.raw(`...`)) with the statement at its start or after a `;`; any
 * string literal that STARTS with one (sql.raw('...'), CompiledQuery.raw
 * ('...'), a constant later passed to either); a `.raw(...)` string with one
 * after a `;`; and Kysely's transaction-control methods. Statement-shaped
 * only, so prose such as an error message mentioning "commit" is not caught;
 * END counts only as a whole statement, so a CASE ... END in a query is not.
 */
const TX_KEYWORDS =
  '(BEGIN|START\\s+TRANSACTION|COMMIT|END\\s*(;|$|\\s+(WORK|TRANSACTION))|ROLLBACK|ABORT|SAVEPOINT|RELEASE|SET\\s+(SESSION\\s+CHARACTERISTICS\\s+AS\\s+)?TRANSACTION|PREPARE\\s+TRANSACTION)'
/** Query text (templates): a statement at the start, or after a `;`. */
const TX_CONTROL_TEXT = `/(^|;)\\s*${TX_KEYWORDS}/i`
/** Plain strings: only when the string itself STARTS with the statement — prose is not caught. */
const TX_CONTROL_STRING = `/^\\s*${TX_KEYWORDS}/i`
/** A string handed to a `.raw(...)` executor, with the statement after a `;`. */
const TX_CONTROL_AFTER_SEMICOLON = `/;\\s*${TX_KEYWORDS}/i`
const NUMBERING_SAVEPOINT_STATEMENT =
  '/^\\s*(SAVEPOINT|RELEASE\\s+SAVEPOINT|ROLLBACK\\s+TO\\s+SAVEPOINT)\\s+finsoft_posting_number\\s*$/'
const kernelTxControlMessage =
  'ADR-0027 (K1): packages/accounting-kernel issues no transaction control — no BEGIN, COMMIT, ' +
  'ROLLBACK, SAVEPOINT, RELEASE or SET TRANSACTION. It runs inside the caller’s transaction. The ' +
  'one exception is the savepoint named finsoft_posting_number in src/queries/journal-writes.ts.'
const kernelTxControlApiSyntax = {
  selector:
    'CallExpression[callee.property.name=/^(transaction|startTransaction|controlledTransaction|savepoint|rollbackToSavepoint|releaseSavepoint|commit|rollback|setIsolationLevel|setAccessMode)$/]',
  message: kernelTxControlMessage,
}
const kernelTxControlStringSyntax = [
  { selector: `Literal[value=${TX_CONTROL_STRING}]`, message: kernelTxControlMessage },
  {
    selector: `CallExpression[callee.property.name='raw'] > Literal[value=${TX_CONTROL_AFTER_SEMICOLON}]`,
    message: kernelTxControlMessage,
  },
]
const kernelTxControlSyntax = [
  kernelTxControlApiSyntax,
  { selector: `TemplateElement[value.raw=${TX_CONTROL_TEXT}]`, message: kernelTxControlMessage },
  ...kernelTxControlStringSyntax,
]
/** journal-writes.ts only: the same, minus the three exact numbering-savepoint statements. */
const journalWritesTxControlSyntax = [
  kernelTxControlApiSyntax,
  {
    selector: `TemplateElement[value.raw=${TX_CONTROL_TEXT}]:not([value.raw=${NUMBERING_SAVEPOINT_STATEMENT}])`,
    message: kernelTxControlMessage,
  },
  ...kernelTxControlStringSyntax,
]

/*
 * The journal is written ONLY by the kernel. ADR-0005 Compliance: "INSERT
 * INTO journal_entries / journal_lines, and any repository method writing
 * those tables, may appear only inside packages/accounting-kernel. Any
 * occurrence in modules/* or apps/* fails the build." Applied to every file
 * except packages/accounting-kernel/src/queries/** and the named test-only
 * exemptions below — by builder call, by sql`` tag, and by a raw query string
 * (a Literal or untagged template handed to a driver).
 */
const JOURNAL_WRITE_TEXT =
  '/\\b(insert\\s+into|update|delete\\s+from|merge\\s+into|truncate)\\s+(table\\s+)?(only\\s+)?(public\\.)?journal_(entries|lines)\\b/i'
const journalWriteMessage =
  'ADR-0005 Compliance: journal_entries and journal_lines are written only by ' +
  'packages/accounting-kernel/src/queries/**. Raise a financial event through ' +
  'postingEngine.post(command, tx) instead — a module never writes the journal.'
const journalWriteSyntax = [
  {
    selector:
      'CallExpression[callee.property.name=/^(insertInto|updateTable|deleteFrom|replaceInto|mergeInto)$/][arguments.0.value=/^journal_(entries|lines)\\b/]',
    message: journalWriteMessage,
  },
  { selector: `TemplateElement[value.raw=${JOURNAL_WRITE_TEXT}]`, message: journalWriteMessage },
  { selector: `Literal[value=${JOURNAL_WRITE_TEXT}]`, message: journalWriteMessage },
]

/*
 * The party register is written ONLY by the kernel. ADR-0026 Compliance 7:
 * insertInto/updateTable/deleteFrom('parties'), or `parties` inside an sql``
 * tag, outside packages/accounting-kernel/src/** (and database/migrations,
 * which ESLint does not read) is a build failure — INCLUDING inside
 * packages/database, which every module's infrastructure layer may import.
 */
const partiesMessage =
  'ADR-0026 Compliance 7: the parties register is written only by packages/accounting-kernel ' +
  '(registerParty). A module registers a customer or vendor by calling registerParty(tx, type) ' +
  'and uses the returned id as its own primary key; nothing else names the table in SQL.'
const partiesWriteSyntax = [
  {
    selector:
      'CallExpression[callee.property.name=/^(insertInto|updateTable|deleteFrom|replaceInto|mergeInto)$/][arguments.0.value=/^parties\\b/]',
    message: partiesMessage,
  },
  {
    selector:
      "TaggedTemplateExpression[tag.name='sql'] TemplateElement[value.raw=/\\bparties\\b/i]",
    message: partiesMessage,
  },
  {
    selector:
      'Literal[value=/\\b(insert\\s+into|update|delete\\s+from|merge\\s+into|truncate)\\s+(table\\s+)?(only\\s+)?(public\\.)?parties\\b/i]',
    message: partiesMessage,
  },
]

/*
 * Period transitions are written ONLY by the kernel. Council T3 (Arch 1/2/5,
 * Acct F3/R3): close / reopen / lock — the calendar lock, the order checks,
 * the UPDATE and the audit record — live in
 * packages/accounting-kernel/src/queries/periods.ts. An UPDATE (or DELETE /
 * MERGE / TRUNCATE) of fiscal_periods anywhere else — by builder call, sql``
 * tag or raw string — is a build failure, INCLUDING inside packages/database,
 * which modules/*\/infrastructure may import. database/migrations is SQL and
 * not linted. INSERT is deliberately not covered: createFiscalYear
 * (packages/database/src/provisioning.ts) creates periods, born OPEN, and
 * that is provisioning, not a transition.
 */
const FISCAL_PERIOD_WRITE_TEXT =
  '/\\b(update|delete\\s+from|merge\\s+into|truncate)\\s+(table\\s+)?(only\\s+)?(public\\.)?fiscal_periods\\b/i'
const fiscalPeriodWriteMessage =
  'Council T3 / ADR-0012: fiscal_periods transitions (close, reopen, lock) are written only by ' +
  'packages/accounting-kernel/src/queries/periods.ts. Call periodEngine.close / ' +
  'periodEngine.reopen / periodEngine.lock from @finsoft/accounting-kernel; no other file may ' +
  'write a period transition.'
const fiscalPeriodWriteSyntax = [
  {
    selector:
      'CallExpression[callee.property.name=/^(updateTable|deleteFrom|mergeInto)$/][arguments.0.value=/^(public\\.)?fiscal_periods\\b/]',
    message: fiscalPeriodWriteMessage,
  },
  {
    selector: `TemplateElement[value.raw=${FISCAL_PERIOD_WRITE_TEXT}]`,
    message: fiscalPeriodWriteMessage,
  },
  { selector: `Literal[value=${FISCAL_PERIOD_WRITE_TEXT}]`, message: fiscalPeriodWriteMessage },
]

/*
 * Kernel-only primitives that packages/database still DEFINES (Council T3
 * Arch 1/2/5, lint-restrict option): document numbering and the reversal
 * row lock. They live in packages/database for its tx plumbing, but calling
 * them outside the kernel either consumes a number no posted entry will
 * carry (a committed gap, 013's header) or takes LOCK_REGISTRY 5a out of
 * the kernel's order. Allowed: packages/accounting-kernel/** (whose blocks
 * do not compose this list) and the database test suites
 * (database/tests/**, tests/security/**). Caught by named import, by
 * namespace member access, by destructuring a dynamic import, and by
 * re-export from @finsoft/database — the definitions and the package
 * index's own relative re-export are not matched.
 */
const KERNEL_ONLY_NAMES =
  '/^(assignDocumentNumber|assignTenantDocumentNumber|lockEntryForReversal)$/'
const kernelOnlyMessage =
  'Council T3: assignDocumentNumber, assignTenantDocumentNumber and lockEntryForReversal are ' +
  'called only by packages/accounting-kernel. Post through postingEngine.post / the reversal ' +
  'engine; a number or reversal lock taken anywhere else breaks rule 12 or LOCK_REGISTRY order.'
const kernelOnlyCallSyntax = [
  { selector: `ImportSpecifier[imported.name=${KERNEL_ONLY_NAMES}]`, message: kernelOnlyMessage },
  { selector: `MemberExpression[property.name=${KERNEL_ONLY_NAMES}]`, message: kernelOnlyMessage },
  {
    selector: `ObjectPattern > Property[key.name=${KERNEL_ONLY_NAMES}]`,
    message: kernelOnlyMessage,
  },
  {
    selector: `ExportNamedDeclaration[source.value=/^@finsoft\\/database/] > ExportSpecifier[local.name=${KERNEL_ONLY_NAMES}]`,
    message: kernelOnlyMessage,
  },
]

/** The registers of financial truth, composed into every block that sets no-restricted-syntax. */
const financialTruthWriteSyntax = [
  ...journalWriteSyntax,
  ...partiesWriteSyntax,
  ...fiscalPeriodWriteSyntax,
  ...kernelOnlyCallSyntax,
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

/*
 * `auth_lookup` is migration 006's schema, owned by `finsoft_refresh` and
 * read only through `packages/database/src/auth/resolvers.ts`'s raw call to
 * `auth_lookup.resolve_refresh`. Restricting the identifier to
 * `packages/database` (and, for the SQL side, `database/migrations`, which
 * ESLint cannot see) is the Architecture seat's A1 condition: nothing
 * outside the one package that owns query construction for auth should even
 * be ABLE to reference the schema by name, whether in a raw SQL string or a
 * comment that later gets copy-pasted into real code.
 */
const authLookupIdentifierSyntax = [
  {
    selector: 'Literal[value=/auth_lookup/]',
    message:
      "ADR-0023 §2 / Architecture seat A1: auth_lookup is migration 006's schema, read only " +
      'through packages/database/src/auth/resolvers.ts. No other package or app may name it.',
  },
  {
    selector: 'TemplateElement[value.raw=/auth_lookup/]',
    message:
      "ADR-0023 §2 / Architecture seat A1: auth_lookup is migration 006's schema, read only " +
      'through packages/database/src/auth/resolvers.ts. No other package or app may name it.',
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
      'no-restricted-syntax': ['error', ...invariantSyntax, ...financialTruthWriteSyntax],
      'no-restricted-imports': [
        'error',
        { paths: [...DECIMAL_LIB_IMPORT_PATHS, REQUEST_SCOPE_IMPORT_BAN] },
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
      'no-restricted-syntax': [
        'error',
        ...invariantSyntax,
        ...stripOnlySyntax,
        ...financialTruthWriteSyntax,
      ],
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
      'no-restricted-syntax': [
        'error',
        ...invariantSyntax,
        ...connectionOwnershipSyntax,
        ...authLookupIdentifierSyntax,
        ...financialTruthWriteSyntax,
      ],
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
        ...authLookupIdentifierSyntax,
        ...stripOnlySyntax,
        ...financialTruthWriteSyntax,
      ],
    },
  },

  /* ---------------------------------------------------------------- *
   * packages/auth builds no queries. ADR-0023 (M1-A), Architecture seat
   * ruling 2026-09-27 — see packagesAuthQuerySyntax above.
   *
   * A later, more specific block: flat config REPLACES no-restricted-syntax
   * per matching file rather than merging it, so this restates the full set
   * (invariant + connection ownership + strip-only) alongside the new
   * selector instead of losing the earlier three for this one package.
   * ---------------------------------------------------------------- */
  {
    files: ['packages/auth/**/*.ts'],
    ignores: ['packages/auth/**/*.spec.ts', 'packages/auth/**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...invariantSyntax,
        ...connectionOwnershipSyntax,
        ...authLookupIdentifierSyntax,
        ...stripOnlySyntax,
        ...packagesAuthQuerySyntax,
        ...financialTruthWriteSyntax,
      ],
    },
  },

  /* ---------------------------------------------------------------- *
   * packages/database/src/auth/{login,refresh}.ts — TenantContext is
   * forbidden here. C2, architecture re-review 2026-09-27.
   *
   * ADR-0023 A2: the tenant for every transaction these two files open
   * enters through `withResolvedTenant(tenantByCodeResolver(...))`
   * exclusively — resolved and branded fresh, every time, never carried
   * forward as a bare string. `TenantContext.run` is exactly the shape of
   * the bug items 1a/1b/N1 (security/database/architecture re-review,
   * 2026-09-27) fixed once already in login.ts: a plain string principal
   * that compiles wherever a `ResolvedTenantId` is expected, with nothing
   * to stop a future edit from threading transaction one's tenant id into
   * transaction two through it instead of re-resolving. Importing
   * `TenantContext` — from the relative path or from the package's own
   * public surface — in either file is the shape of that regression, not
   * merely a style preference.
   *
   * Restates DECIMAL_LIBS from the repo-wide block above: flat config
   * REPLACES a rule's options per matching file rather than merging them,
   * and neither login.ts nor refresh.ts has any legitimate reason to import
   * a decimal library either.
   * ---------------------------------------------------------------- */
  {
    files: ['packages/database/src/auth/login.ts', 'packages/database/src/auth/refresh.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...DECIMAL_LIBS.map((name) => ({
              name,
              message:
                'ADR-0011/ADR-0014: import Money from @finsoft/validation. The decimal library ' +
                'lives there and nowhere else.',
            })),
            {
              name: '../tenant-context.ts',
              message:
                'ADR-0023 A2 / architecture re-review C2, 2026-09-27: the tenant for this file ' +
                'enters ONLY through withResolvedTenant(tenantByCodeResolver(...)) — never ' +
                'TenantContext, which carries a bare, unbranded tenant id across the read/write ' +
                'boundary and was the exact shape of the login TOCTOU this file already fixed once.',
            },
            {
              name: '@finsoft/database',
              importNames: ['TenantContext'],
              message:
                'ADR-0023 A2 / architecture re-review C2, 2026-09-27: TenantContext is forbidden ' +
                "in this file by any import path — see this block's own comment.",
            },
          ],
        },
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
        ...authLookupIdentifierSyntax,
        ...appsQuerySyntax,
        ...financialTruthWriteSyntax,
      ],
    },
  },

  /* ---------------------------------------------------------------- *
   * M1-X T2: TenantContext is importable in apps/** only by the
   * request-scoping interceptor and, below,
   * apps/worker/src/outbox/dispatcher.ts (Council re-review Arch R2: the
   * one worker file that needs it, named specifically rather than
   * exempting apps/worker/** wholesale — no other job in apps/worker
   * imports it today, and a new one that starts to must be a deliberate,
   * reviewed addition to this list, not a silent grant). Everywhere else in
   * apps/** — including PermissionGuard, which gets its OWN, more specific
   * block next (it may import withTenantAsPrincipal from request-scope, and
   * nothing else here permits) — is banned from importing it at all.
   * ---------------------------------------------------------------- */
  {
    files: ['apps/**/*.ts', 'apps/**/*.tsx'],
    ignores: [
      'apps/**/*.spec.ts',
      'apps/**/*.test.ts',
      'apps/worker/src/outbox/dispatcher.ts',
      'apps/api/src/common/tenant-context.interceptor.ts',
      'apps/api/src/common/permission.guard.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...DECIMAL_LIB_IMPORT_PATHS,
            REQUEST_SCOPE_IMPORT_BAN,
            TENANT_CONTEXT_IMPORT_BAN,
            TESTING_IMPORT_BAN,
            PROVISIONING_IMPORT_BAN,
          ],
        },
      ],
    },
  },

  /* ---------------------------------------------------------------- *
   * Security seat, final check on a7576ac (medium). The interceptor and
   * the outbox dispatcher are excluded from the block above (`ignores`)
   * specifically so their own legitimate `TenantContext` import is not
   * caught by `TENANT_CONTEXT_IMPORT_BAN` — but `ignores` means the WHOLE
   * block skips them, not just that one entry, so they were also escaping
   * every other ban that block carries: decimal libraries, request-scope,
   * and (Council re-review item 1) testing/provisioning. Nothing else in
   * this file matched them, so nothing replaced the missing rule either —
   * this is the block that should have existed alongside the `ignores`.
   *
   * `TenantContext` itself is deliberately absent from this list: that
   * import is the entire reason these two files are named here rather than
   * covered by the block above.
   * ---------------------------------------------------------------- */
  {
    files: [
      'apps/api/src/common/tenant-context.interceptor.ts',
      'apps/worker/src/outbox/dispatcher.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...DECIMAL_LIB_IMPORT_PATHS,
            REQUEST_SCOPE_IMPORT_BAN,
            TESTING_IMPORT_BAN,
            PROVISIONING_IMPORT_BAN,
          ],
        },
      ],
    },
  },

  /* ---------------------------------------------------------------- *
   * The one file allowed to import withTenantAsPrincipal from
   * request-scope (M1-X T1) — and, per T2, ALSO banned from importing
   * TenantContext directly: PermissionGuard establishes its tenant scope
   * through withTenantAsPrincipal, never TenantContext.run itself.
   * ---------------------------------------------------------------- */
  {
    files: ['apps/api/src/common/permission.guard.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...DECIMAL_LIB_IMPORT_PATHS,
            TENANT_CONTEXT_IMPORT_BAN,
            TESTING_IMPORT_BAN,
            PROVISIONING_IMPORT_BAN,
          ],
        },
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
        ...authLookupIdentifierSyntax,
        ...appsQuerySyntax,
        ...stripOnlySyntax,
        ...financialTruthWriteSyntax,
      ],
    },
  },

  /* ---------------------------------------------------------------- *
   * M1-X T2: TenantContext is importable only in packages/database and
   * packages/auth. Every other package — permissions, reporting,
   * shared-types, observability, ui, and the kernels/validation (which get
   * their own more specific blocks, above and below) — establishes a
   * tenant scope through withTenant/withGlobal (received via callback),
   * never by importing TenantContext to do it locally.
   * ---------------------------------------------------------------- */
  {
    files: ['packages/*/src/**/*.ts', 'packages/*/src/**/*.tsx'],
    ignores: ['packages/database/**', 'packages/auth/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...DECIMAL_LIB_IMPORT_PATHS,
            REQUEST_SCOPE_IMPORT_BAN,
            TENANT_CONTEXT_IMPORT_BAN,
            TESTING_IMPORT_BAN,
            PROVISIONING_IMPORT_BAN,
          ],
        },
      ],
    },
  },

  /* ---------------------------------------------------------------- *
   * packages/permissions builds no queries either. Architecture seat
   * ruling, M1-R (docs/briefs/M1-R-rbac.md): it is not on depcruise's
   * kysely-is-allowlisted list, so a `tx.selectFrom(...)` reached through a
   * transaction handle packages/database hands it via callback would be
   * invisible to the module graph in exactly the way apps/**'s was — no
   * import of kysely, no import of pg, just a parameter. The query bodies
   * live in packages/database/src/rbac/*.ts; this package calls them.
   *
   * A separate block rather than folding this into the shared per-package
   * block above: the auth lane is making the identical addition for
   * packages/auth at the same time, and two edits adding their own block
   * merge cleanly where two edits to the same array or object do not.
   * ---------------------------------------------------------------- */
  {
    files: ['packages/permissions/src/**/*.ts'],
    ignores: ['packages/permissions/src/**/*.spec.ts', 'packages/permissions/src/**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...invariantSyntax,
        ...connectionOwnershipSyntax,
        ...stripOnlySyntax,
        ...appsQuerySyntax,
        ...financialTruthWriteSyntax,
      ],
    },
  },

  /* ---------------------------------------------------------------- *
   * packages/accounting-kernel — business logic constructs no query; the
   * query bodies live in src/queries/**. M2-A, ADR-0005, ADR-0026 — see
   * accountingKernelLogicQuerySyntax above. Restates invariant + connection
   * ownership + auth_lookup + strip-only, because a later block REPLACES
   * no-restricted-syntax per file (an earlier draft of this block dropped
   * the auth_lookup ban for the kernel exactly that way).
   * ---------------------------------------------------------------- */
  {
    files: ['packages/accounting-kernel/**/*.ts'],
    ignores: [
      'packages/accounting-kernel/**/*.spec.ts',
      'packages/accounting-kernel/**/*.test.ts',
      'packages/accounting-kernel/src/queries/**',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...invariantSyntax,
        ...connectionOwnershipSyntax,
        ...authLookupIdentifierSyntax,
        ...stripOnlySyntax,
        ...accountingKernelLogicQuerySyntax,
        ...kernelTxControlSyntax,
      ],
    },
  },

  /* ---------------------------------------------------------------- *
   * packages/accounting-kernel/src/queries/** — the only place in the
   * system that writes journal_entries, journal_lines and parties
   * (ADR-0005, ADR-0026). Everything else still applies.
   * ---------------------------------------------------------------- */
  {
    files: ['packages/accounting-kernel/src/queries/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...invariantSyntax,
        ...connectionOwnershipSyntax,
        ...authLookupIdentifierSyntax,
        ...stripOnlySyntax,
        ...kernelTxControlSyntax,
      ],
    },
  },

  /* ---------------------------------------------------------------- *
   * packages/accounting-kernel/src/queries/journal-writes.ts — as above,
   * except the three whole statements on the ADR-0027 numbering savepoint
   * `finsoft_posting_number`. Restates everything, because this block
   * REPLACES no-restricted-syntax for the file.
   * ---------------------------------------------------------------- */
  {
    files: ['packages/accounting-kernel/src/queries/journal-writes.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...invariantSyntax,
        ...connectionOwnershipSyntax,
        ...authLookupIdentifierSyntax,
        ...stripOnlySyntax,
        ...journalWritesTxControlSyntax,
      ],
    },
  },

  /* ---------------------------------------------------------------- *
   * The suites that PROVE the journal/party write boundary have to be able
   * to attempt the forbidden write — the same reasoning, and the same two
   * directories, as the connection-ownership exemption above — plus the one
   * FinancialInvariantSuite file that proves Invariants 1, 4 and 5 by
   * watching the database refuse a write made around the kernel. Tests only;
   * no production code is exempted.
   * ---------------------------------------------------------------- */
  {
    files: ['database/tests/**/*.ts', 'tests/security/**/*.ts'],
    rules: { 'no-restricted-syntax': ['error', ...invariantSyntax] },
  },
  {
    files: ['tests/accounting/posting-invariants.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...invariantSyntax,
        ...connectionOwnershipSyntax,
        ...authLookupIdentifierSyntax,
      ],
    },
  },
  {
    /*
     * packages/reporting's integration fixture writes AR/AP lines carrying a
     * party, which no ENABLED posting rule can produce in M2 (SALE_POSTED and
     * CUSTOMER_PAYMENT_RECEIVED are RULE_NOT_ENABLED until M3). Named file,
     * test-only. Once M3 enables those rules the fixture should post through
     * the kernel and this block should go.
     */
    files: ['packages/reporting/src/reporting.integration.spec.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...invariantSyntax,
        ...connectionOwnershipSyntax,
        ...authLookupIdentifierSyntax,
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
    rules: {
      // Decimal libraries are deliberately NOT restricted here — this is
      // the one package allowed to import them. M1-X T2 still bans
      // TenantContext and request-scope — validation never legitimately
      // needs a tenant scope. Council re-review 1: nor does it ever need a
      // test fixture or a provisioning helper.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            TENANT_CONTEXT_IMPORT_BAN,
            REQUEST_SCOPE_IMPORT_BAN,
            TESTING_IMPORT_BAN,
            PROVISIONING_IMPORT_BAN,
          ],
        },
      ],
    },
  },

  /* ---------------------------------------------------------------- *
   * M1-X, Council re-review item 1: packages/auth is excluded from the
   * generic "packages/<name>/src" block above (it is one of the two packages
   * allowed to import TenantContext directly), so it needs its own
   * statement of the testing/provisioning ban — a narrower one than that
   * block's, since TenantContext and request-scope stay allowed here.
   * Restates DECIMAL_LIB_IMPORT_PATHS too: flat config replaces
   * no-restricted-imports per matching file rather than merging it, and the
   * repo-wide block's decimal-library ban would otherwise be lost for this
   * package the moment this more specific block also matches its files.
   * ---------------------------------------------------------------- */
  {
    files: ['packages/auth/src/**/*.ts'],
    ignores: ['packages/auth/src/**/*.spec.ts', 'packages/auth/src/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...DECIMAL_LIB_IMPORT_PATHS,
            REQUEST_SCOPE_IMPORT_BAN,
            TESTING_IMPORT_BAN,
            PROVISIONING_IMPORT_BAN,
          ],
        },
      ],
    },
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
            // M1-X T2: kernels import withTenant/withGlobal, never TenantContext directly.
            TENANT_CONTEXT_IMPORT_BAN,
            REQUEST_SCOPE_IMPORT_BAN,
            // Council re-review 1: nor a test fixture or a provisioning helper.
            TESTING_IMPORT_BAN,
            PROVISIONING_IMPORT_BAN,
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
   * M1-X T2: TenantContext is never imported anywhere in modules/** —
   * application, infrastructure and api layers scope a tenant through
   * withTenant/withGlobal (received via a callback, or their own repository
   * base class), never by establishing their own AsyncLocalStorage scope.
   * domain/ already bans the whole @finsoft/database package (below, and
   * stricter than this); this covers the layers that legitimately import
   * OTHER things from it.
   * ---------------------------------------------------------------- */
  {
    files: ['modules/**/*.ts', 'modules/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...DECIMAL_LIB_IMPORT_PATHS,
            REQUEST_SCOPE_IMPORT_BAN,
            TENANT_CONTEXT_IMPORT_BAN,
            TESTING_IMPORT_BAN,
            PROVISIONING_IMPORT_BAN,
          ],
        },
      ],
    },
  },

  /* ---------------------------------------------------------------- *
   * Module domain layers — pure TypeScript
   * ARCHITECTURE.md §2: "no NestJS, no ORM, no HTTP"
   *
   * A LATER, more specific block than the one just above — flat config
   * replaces no-restricted-imports per matching file, so domain/ needs its
   * own full list rather than relying on the broader modules/** block. Its
   * blanket @finsoft/database ban (below) is already stricter than M1-X
   * T2's TenantContext-only ban, so it is not repeated here.
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
            // Council re-review 1: the blanket ban above does not match
            // subpath specifiers (no-restricted-imports matches the exact
            // string), so these need stating explicitly too.
            TESTING_IMPORT_BAN,
            PROVISIONING_IMPORT_BAN,
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
            // Council re-review 1: the ban above matches only the bare
            // specifier, not a subpath — stated explicitly here too.
            TESTING_IMPORT_BAN,
            PROVISIONING_IMPORT_BAN,
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

  /* ---------------------------------------------------------------- *
   * M1-X, Council re-review item 1 (Security F1 / Database C5).
   * @finsoft/database/testing (runAs — TenantContext.run with any
   * caller-supplied principal) has no legitimate caller anywhere under
   * tools/: it is a Vitest fixture helper against the disposable TEST
   * database, not a provisioning or seeding mechanism. Every tools/ script,
   * including tools/seed/**, is banned — a separate, narrower block below
   * allows tools/seed/** to import @finsoft/database/provisioning instead.
   *
   * Security seat, final check on a7576ac (low regression): restates
   * DECIMAL_LIB_IMPORT_PATHS and REQUEST_SCOPE_IMPORT_BAN, which the
   * repo-wide block above already bans for every file with no `files` key
   * — including every tools/ script — until a LATER, more specific block
   * matches the same file and flat config replaces its no-restricted-imports
   * setting wholesale rather than merging it. Without restating them here,
   * this block's own match on every tools/ script silently dropped both
   * bans the moment this task added it.
   * ---------------------------------------------------------------- */
  {
    files: ['tools/**/*.mjs'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [...DECIMAL_LIB_IMPORT_PATHS, REQUEST_SCOPE_IMPORT_BAN, TESTING_IMPORT_BAN],
        },
      ],
    },
  },

  /* ---------------------------------------------------------------- *
   * M1-X, Council re-review item 1 (Security F1 / Database C5).
   * @finsoft/database/provisioning is importable only from tools/seed/**
   * (the demo seed script today; the M2 backfill CLI,
   * tools/seed/backfill-accounting.mjs, when it lands) — restated with
   * TESTING_IMPORT_BAN rather than left to the block above, because flat
   * config replaces no-restricted-imports per matching file: without this,
   * a tools/seed/** file matching BOTH this block and the one above would
   * keep only whichever config happens to be listed last, silently
   * dropping the other ban. DECIMAL_LIB_IMPORT_PATHS and
   * REQUEST_SCOPE_IMPORT_BAN restated for the same reason as the block
   * above (Security seat, final check on a7576ac).
   * ---------------------------------------------------------------- */
  {
    files: ['tools/**/*.mjs'],
    ignores: ['tools/seed/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...DECIMAL_LIB_IMPORT_PATHS,
            REQUEST_SCOPE_IMPORT_BAN,
            TESTING_IMPORT_BAN,
            PROVISIONING_IMPORT_BAN,
          ],
        },
      ],
    },
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
