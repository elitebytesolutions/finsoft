# Users

| | |
|---|---|
| **Route** | `/admin` |
| **Archetype** | A — Register |
| **Module / permission** | Administration · `Admin & Control` · `user:manage` |
| **Prototype source** | `ui-prototype/src/App.tsx` (`Admin`, Users tab) |
| **Posts to the ledger** | no — but it decides who can |

## 1. Purpose

Who has access, with what role, from where, and what they have been doing. This screen is a security
surface: every control on it is an authorisation decision.

## 2. Anatomy

```
PageHead   "Admin & control" · "Manage people, permissions, periods and every security-sensitive
            action." · [Export] [+ Invite user]
Tabs       Users · Roles & permissions · Audit log · Sessions
KpiRow     Active users · Pending invites · Admins · Sessions active now
FilterBar  search · role · branch · status · last active
DataTable  User · Role · Branch · 2FA · Last active · Status · Actions
Panel      "Active sessions" — User · Role · Device · Location · Last active · Status · [Revoke]
Modal      Invite / edit user
```

## 3. Components

`Tabs` · `KpiRow` · `DataTable` · `Modal` · `StatusBadge` · `UserCell` · `ConfirmDialog` ·
`ExportMenu`.

## 4. Columns

| Column | Align | Format |
|---|---|---|
| User | left | avatar + name (700) + 9.5px email |
| Role | left | role chip; `Owner`/`Admin` in `danger` tone so privilege is visible at a glance |
| Branch | left | scope of access |
| 2FA | left | Enabled `good` · Not enabled `warn` |
| Last active | left | absolute timestamp, never "a while ago" |
| Status | left | Active `good` · Invited `info` · Suspended `warn` · Disabled `neutral` |
| Actions | right | View · Edit role · Reset password · Revoke sessions · Suspend · Disable |

## 5. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| Invite user | primary | `user:manage` | no | Sends an invite; the user appears as `Invited` |
| Change role | row | `user:manage` | **yes — names the permissions gained and lost** | Effective immediately; audited |
| Reset password | row | `user:manage` | **yes** | Sends a reset; never displays a password |
| Revoke sessions | row | `user:manage` | **yes** | Signs the user out everywhere |
| Suspend / Disable | row | `user:manage` | **yes** | Blocks sign-in; the user's history remains |
| Delete | — | — | — | **Never offered** — a user who posted entries must remain attributable |

## 6. Security rules made visible

- A user can never change their own role or disable themselves; those controls are absent on their
  own row with a stated reason.
- The last remaining Owner cannot be disabled or demoted; the dialog explains.
- Privilege changes, password resets and session revocations are always confirmed and always
  audited.
- Passwords are never displayed, emailed in plaintext, or shown in a toast.
- A user's tenant scope is fixed at invitation; moving a user between tenants is not an in-app
  action.

## 7. States

Pending invites listed with their expiry; a user with no activity for 90 days carries a `warn` chip;
an account with 2FA disabled is flagged when the tenant policy requires it.

## 8. Responsive · 9. Accessibility

`md` sessions panel moves below · `xs` card list.
Role chips carry text; destructive actions are last in the menu and separated; the confirm dialogs
state consequences in sentences.

## 10. Open questions

1. Is 2FA mandatory for Owner and Accountant roles?
2. Is SSO in scope, and does it change role assignment?
3. What is the session lifetime and idle timeout policy?
   ([ADR-0009](../../../adr/ADR-0009-jwt-access-and-rotating-refresh-tokens.md) governs the tokens;
   the UI needs the numbers.)
