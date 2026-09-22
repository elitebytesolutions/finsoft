'use client'
/* The mock data façade — the single import path for screen data.
 *
 * WHY THIS EXISTS. ARCHITECTURE.md §2 and CLAUDE.md say apps/web contains no
 * business rules: "if the browser is deciding a number, that is a bug". The
 * prototype this UI was ported from does decide numbers in the browser — it
 * builds journal lines, mutates stock and derives balances in store.ts.
 *
 * That logic is quarantined here rather than spread across 78 routes. Screens
 * call the façade and never reach past it, so when the NestJS API and the
 * accounting/inventory kernels land, this file changes and the screens do not.
 *
 * Until then, nothing in this folder is authoritative. It is demo state in
 * localStorage. No number rendered from it has been posted to a ledger. */
export * from './data'
export type { AppData } from './store'
// Both names are exported: `useFinsoftData` is the facade's own name, and
// `usePersistentData` is kept because ported screens type their props as
// ReturnType<typeof usePersistentData>['data'].
export { usePersistentData, usePersistentData as useFinsoftData } from './store'
