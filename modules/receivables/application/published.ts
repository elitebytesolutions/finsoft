/*
 * modules/receivables/application/published.ts — the ONLY cross-module
 * import target for this module (ADR-0028 statement 3). modules.md §2:
 * receivables publishes NOTHING in M3 — no later-Wave module consumes it
 * yet (Wave 7's "sales" flow will call this through a published interface
 * when it raises invoices itself). The file exists, empty, so the package's
 * `"./published"` export target (package.json) resolves, and so a future
 * addition here is reviewed the same way modules/customers/application/
 * published.ts was — as a public surface, kept small on purpose.
 */
export {}
