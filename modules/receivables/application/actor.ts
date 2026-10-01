/*
 * The command-layer actor. Threaded explicitly from the controller (which
 * reads the authenticated request) through every use case's command, for
 * this module's OWN `recordAudit` calls — modules cannot read
 * `TenantContext` themselves (ADR-0028 S1). The kernel's own actor for
 * `postingEngine.post` / `reverseForSource` / `documentNumbers.next` is
 * always ambient, via the `TenantTx` (ADR-0028 statement 6); this is a
 * separate, parallel fact for the module's document-audit trail.
 */
export interface Actor {
  readonly userId: string
}
