/*
 * Feature switches for capability the UI is built for but the API does not serve yet.
 * A switch here means: the affordance stays in the DOM (never deleted — see CLAUDE.md's
 * screen-parity rule), but is inert and says so, until the flag flips.
 */

/**
 * Chart of Accounts "Add account" / "Edit". The PO wants account creation in the MVP
 * (M2-UI brief); the Accounting seat is writing the spec now and the API does not exist yet
 * (`coa-standard.md` §5 still says the M2 chart is read-only). Off by default: flipping this
 * on ahead of a real `POST /api/accounts` would let a user submit a form that 404s, or worse,
 * silently do nothing. Flip only once that endpoint exists.
 */
export const ACCOUNT_CREATE_ENABLED = false
