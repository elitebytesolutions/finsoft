/*
 * @finsoft/database/auth — the persistence boundary for login, refresh and
 * session lifecycle. ADR-0023 (M1-A).
 *
 * A separate subpath, not folded into the package's main index: the main
 * surface is deliberately narrow (see index.ts's own header), and this is a
 * distinct, larger surface aimed at exactly one caller, packages/auth.
 *
 * Architecture seat ruling, 2026-09-27: this package holds no business
 * rules. Every function here takes parameters and returns rows or ids;
 * the decision of what a password verifying, a status being ACTIVE, or an
 * outcome being success or failure MEANS is made by the caller and passed
 * in (login) or read back out (refresh) — never decided in this package.
 * This package imports neither packages/auth nor packages/permissions.
 */

export {
  withLoginAttempt,
  type LoginAttemptResult,
  type LoginAuditHook,
  type LoginAuditOutcome,
  type LoginCandidate,
  type LoginCandidateUser,
  type LoginDecision,
  type LoginSessionWrite,
  type LoginSuccess,
  type LoginTestHooks,
} from './login.ts'

export {
  spendRefreshToken,
  type RefreshOutcome,
  type RefreshReuseAuditHook,
  type RefreshReuseAuditOutcome,
  type SpendRefreshTokenParams,
  type RefreshTestHooks,
} from './refresh.ts'

export {
  getAccountState,
  getAuthenticatedProfile,
  isSessionActive,
  revokeSession,
  touchSessionLastSeen,
  type AccountState,
  type AuthenticatedProfile,
} from './session.ts'
