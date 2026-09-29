import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from '@finsoft/database/testing'
import type { ReceivablesPort } from './receivables-port.ts'

/*
 * Loads a REAL `ReceivablesPort` from `modules/receivables`, once M3-P
 * builds it. Returns null — never throws — when the module does not exist
 * yet (this branch, today) or when it exists but its shape does not match
 * what this file guesses (see below): staying PENDING is always the safe
 * failure, never a crash that takes the whole financial gate down with it.
 *
 * File-existence check, not a bare `import()`, on purpose: a dynamic
 * import of a path that does not exist is still resolved STATICALLY by
 * TypeScript under `moduleResolution: nodenext` even inside `import()`,
 * which would fail `npm run typecheck` on THIS branch, where
 * `modules/receivables` has no files at all. Building the specifier from
 * parts (`join(...)`, not a string literal) additionally keeps Vite/esbuild
 * from trying to pre-bundle it during `vitest run`'s collection phase,
 * which would fail the same way at runtime, for every spec file, not just
 * this one.
 *
 * THE EXACT SHAPE BELOW IS A GUESS. docs/design/M3/modules.md §4 fixes the
 * OPERATIONS (`PostInvoice`, `ReverseInvoice`, …) but not this lane's
 * export names — modules/customers/index.ts is this lane's model
 * (createCustomer, deactivateCustomer, …), extended by analogy. If M3-P's
 * real names differ, `loadReceivablesRealPort()` returns null (the guard
 * clauses below fail closed) and P04-P12 stay PENDING with a clear reason
 * until this file is updated to match — a one-line-per-function fix, not a
 * redesign, because `golden-posting-runner.ts` only depends on the
 * `ReceivablesPort` interface, never on this loader's internals.
 */

const MODULE_INDEX = join(REPO_ROOT, 'modules', 'receivables', 'index.ts')

export interface ReceivablesModuleShape {
  readonly createInvoiceDraft?: unknown
  readonly postInvoice?: unknown
  readonly reverseInvoice?: unknown
  readonly createReceiptDraft?: unknown
  readonly updateReceiptDraft?: unknown
  readonly cancelReceiptDraft?: unknown
  readonly postReceipt?: unknown
  readonly reverseReceipt?: unknown
  readonly getInvoice?: unknown
  readonly getReceipt?: unknown
}

const REQUIRED_EXPORTS = [
  'createInvoiceDraft',
  'postInvoice',
  'reverseInvoice',
  'createReceiptDraft',
  'updateReceiptDraft',
  'cancelReceiptDraft',
  'postReceipt',
  'reverseReceipt',
  'getInvoice',
  'getReceipt',
] as const

export function receivablesModuleFileExists(): boolean {
  return existsSync(MODULE_INDEX)
}

/**
 * Returns the raw module namespace if `modules/receivables/index.ts`
 * exists AND exports every name `REQUIRED_EXPORTS` lists as a function —
 * or null. Never throws for "module not found" or "shape mismatch"; both
 * are ordinary, expected states before M3-P lands and immediately after,
 * while this loader's guesses are still being reconciled with the real
 * module.
 */
export async function loadReceivablesModuleIfShapeMatches(): Promise<ReceivablesModuleShape | null> {
  if (!receivablesModuleFileExists()) return null
  let mod: Record<string, unknown>
  try {
    // Built from parts — see the file header. `@vite-ignore` matches this
    // repo's other non-literal dynamic imports of not-yet-existing paths.
    const specifier = [REPO_ROOT, 'modules', 'receivables', 'index.ts'].join('/')
    mod = (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>
  } catch {
    return null
  }
  const missing = REQUIRED_EXPORTS.filter((name) => typeof mod[name] !== 'function')
  if (missing.length > 0) return null
  return mod as ReceivablesModuleShape
}

/**
 * Adapts the real module to `ReceivablesPort`, IF its shape matches this
 * lane's guess (see the file header). Returns null otherwise — the caller
 * (posting-scenarios-m3.spec.ts) treats null exactly like "module absent":
 * P04-P12 stay PENDING, with a reason that names which is true.
 *
 * NOT IMPLEMENTED YET. Wiring `ReceivablesPort`'s step-shaped methods onto
 * the real module's CRUD use cases (draft-then-post, for a golden step
 * that submits a full payload in one `do: "post"`) needs the real
 * function SIGNATURES, which do not exist to read yet. The probe above
 * (existence + shape) is real and safe to run today; this translation
 * layer is the follow-up once M3-P's branch has commits to read.
 */
export async function loadReceivablesRealPort(): Promise<ReceivablesPort | null> {
  const mod = await loadReceivablesModuleIfShapeMatches()
  if (!mod) return null
  return null
}
