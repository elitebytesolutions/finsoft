# User detail

| | |
|---|---|
| **Route** | `/admin/users/:id` |
| **Archetype** | F — Master record |
| **Module / permission** | Administration · `Admin & Control` · `user:manage` |
| **Prototype source** | `ui-prototype/src/detail-pages.tsx` (`UserDetail`) |
| **Posts to the ledger** | no |

## 1. Purpose

One user: their access, their devices, and everything they have done. This is the page an auditor
opens after an incident, so completeness matters more than brevity.

## 2. Anatomy

```
Breadcrumbs  Administration > Users > Usman Ali
RecordHeader avatar · name (h1) · email · role chip · [Active] · [Edit role] [Revoke sessions] [More v]
KpiRow       Role · Branch scope · 2FA · Last active
Tabs         Overview · Permissions · Sessions · Audit trail · Documents posted
  Overview   DefinitionGrid: name, email, phone, role, branch, created, invited by, last password
             change, 2FA status
  Permissions the effective permission list, grouped by module, marked inherited-from-role or
             granted-directly
  Sessions   Device · Location · Last active · IP · [Revoke]
  Audit      Date · Action · Entity · Detail · IP — filterable, exportable
  Documents  every financial document this user created, posted or reversed, with links
```

## 3. Components

`RecordHeader` · `KpiRow` · `Tabs` · `DefinitionGrid` · `PermissionList` (page-local) ·
`DataTable` · `Timeline` · `ConfirmDialog` · `ExportMenu`.

## 4. Rules

- The Permissions tab shows the **effective** set, not the role definition — what this user can
  actually do, with the source of each grant named.
- The Audit tab is read-only, append-only, and cannot be filtered in a way that hides entries
  without saying so ("3 entries hidden by the current filter").
- IP addresses and device fingerprints are shown to `Admin & Control` only.
- The Documents tab exists because attribution is the reason a user is never deleted.

## 5. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| Edit role | primary | `user:manage` | **yes — names permissions gained and lost** | Immediate; audited |
| Revoke sessions | secondary | `user:manage` | **yes** | Signs out everywhere |
| Reset password | overflow | `user:manage` | **yes** | Sends a reset link |
| Suspend / Disable | overflow (danger) | `user:manage` | **yes** | Blocks sign-in; history preserved |
| Export audit | overflow | `Admin & Control` | no | CSV of this user's audit entries for a period |

Self-service restrictions from [admin users](../admin-users/) apply here too: no self role change, no
self disable, last-Owner protection.

## 6. States

Not found → shared Not found. Suspended → a persistent `warn` banner with who suspended and when.
No audit entries in range → the range is named. A user with posted documents shows the count in the
header, so nobody attempts to remove them.

## 7. Responsive · 8. Accessibility

`md` KPI 2×2 · `sm` tabs become a select · `xs` card lists.
The permission list is a definition list grouped by module with the grant source in text; the role
chip's privilege level is in its accessible name.

## 9. Open questions

1. How long is the audit trail retained, and can it be exported in bulk for an external auditor?
2. Are direct per-user permission grants allowed at all, or only role-based access?
3. Should a user see their own audit trail?
