/*
 * Shared, honest presentation of a raw audit event — used by the Audit Trail screen
 * (`/admin-audit`) and by the Customer detail "Recent Interactions" card, so both render
 * the same action the same way instead of two guesses at the same string.
 *
 * Deliberately does NOT invent detail beyond what `action`/`entityType` name. The mock
 * this replaces fabricated specific amounts and names ("Rs 200,000 via Bank Transfer");
 * this adapter only ever states what actually happened, from the record itself.
 */
import type { AuditEvent } from '../api/audit-types'

/** `CUSTOMER_DEACTIVATED` -> `Customer deactivated`. Generic: works for any action code. */
export function humanizeAction(action: string): string {
  const words = action.toLowerCase().split('_').filter(Boolean)
  if (words.length === 0) return action
  return words[0].charAt(0).toUpperCase() + words[0].slice(1) + ' ' + words.slice(1).join(' ')
}

/**
 * A short "who" label from an actor id alone — no user-directory lookup is in this lane's
 * scope (OBSERVED in the M4-W report), so this is deliberately not a real name. `null` is a
 * genuine, documented case (migration 009): a job/system action, or the chain-anchor row.
 * `currentUserId` (from `useAuth().user.id`) lets the one id a viewer can actually recognise
 * — their own — read as "You" instead of a meaningless fragment; every other id stays a
 * short, clearly-a-fragment "User · 9d92…" rather than the raw uuid (which both overflows a
 * pill and asks the reader to do the id-matching by eye).
 */
export function actorLabel(actorUserId: string | null, currentUserId?: string | null): string {
  if (!actorUserId) return 'System'
  if (currentUserId && actorUserId === currentUserId) return 'You'
  return `User · ${actorUserId.slice(0, 4)}…`
}

/** A short "what" label from an entity id alone. `null` when the event has no single
 * associated record (e.g. a login) — never guessed at. */
export function entityLabel(entityId: string | null): string {
  return entityId ? entityId.slice(0, 8) : '—'
}

export type ActivityTone = 'green' | 'blue' | 'orange' | 'red'

/** Best-effort colour grouping for the timeline dot — create/reactivate read as positive,
 * deactivate/denied as a caution, everything else neutral-blue. Cosmetic only. */
export function activityTone(event: Pick<AuditEvent, 'action'>): ActivityTone {
  const a = event.action.toUpperCase()
  if (a.includes('CREATE') || a.includes('REACTIVAT') || a.includes('POST')) return 'green'
  if (a.includes('DEACTIVAT') || a.includes('DENIED') || a.includes('FAIL') || a.includes('REVERS'))
    return 'orange'
  return 'blue'
}
