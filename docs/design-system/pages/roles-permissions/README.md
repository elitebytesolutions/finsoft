# Roles & permissions

| | |
|---|---|
| **Route** | `/admin-roles` |
| **Archetype** | A — Register (matrix) |
| **Module / permission** | Administration · `Admin & Control` · `role:manage` |
| **Prototype source** | `ui-prototype/src/App.tsx` (`Admin`, Roles & permissions tab), `src/data.ts` (`actionPermissions`) |
| **Posts to the ledger** | no — it defines who may |

## 1. Purpose

Define what each role can see and do. The permission model is a **Level 1** concern: a change here
is an architectural change, not a preference, and the screen should feel that way.

## 2. Anatomy

```
PageHead   "Roles & permissions" · [Export matrix] [+ New role]
RoleList   Owner · Accountant · Purchase & Inventory · Pharmacist · Salesman · Auditor · (custom)
           each with a user count
Matrix     rows = permissions grouped by module
           columns = roles
           cells = ☑ granted · ☐ not granted · 🔒 fixed (cannot be changed)
Legend     module access · action permissions (create, post, reverse, approve) · data visibility
           (cost, salary, full account numbers)
Drawer     role detail: name, description, users, effective permissions, change history
```

## 3. Components

`PermissionMatrix` (page-local: sticky first column, sticky header row, cell toggles) ·
`Drawer` · `ConfirmDialog` · `Badge` · `ExportMenu` · `Timeline` (change history).

## 4. Permission taxonomy

| Group | Examples |
|---|---|
| Module access | Dashboard · Cash, Bank & GL · Sales & POS · Purchasing · Inventory · Products · Masters · HR & Payroll · Reports · Admin & Control |
| Action | `voucher:create` · `voucher:reverse` · `voucher:approve` · `sale:create` · `purchase:create` · `po:create` · `payment:create` · `stock:post` · `master:create` · `master:edit` · `master:delete` · `payroll:post` · `period:close` · `credit:manage` · `bank:reconcile` · `user:manage` · `role:manage` |
| Data visibility | `stock:view-cost` · `hr:view-salary` · `bank:view-full-number` |

Module access alone never implies an action. Seeing the voucher register does not imply posting.

## 5. Fixed permissions — not editable by anyone

- `period:close` cannot be granted to a role without `Cash, Bank & GL`.
- No role can be granted the ability to hard-delete a financial record, edit a posted entry, or
  post into a closed period. These do not exist as permissions, so they cannot appear in the matrix
  as unchecked boxes waiting to be ticked.
- The Owner role cannot have permissions removed below the set required to restore access.
- The Auditor role is read-only by construction: action permissions are shown as 🔒.

## 6. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| Toggle a permission | cell | `role:manage` | **yes — names the role, the permission, the user count affected, and whether it takes effect immediately** | Audited; effective on next request |
| New role | primary | `role:manage` | no | Starts from a copy of an existing role |
| Delete role | overflow (danger) | `role:manage` | **yes** | Only when no users hold it |
| Export matrix | secondary | `Admin & Control` | no | CSV for the security review |

## 7. States

A role with zero users carries an `info` chip. A change that would leave no user with `role:manage`
is refused with that reason. Pending changes are applied on save, not per click, and the unsaved
count is shown.

## 8. Responsive · 9. Accessibility

The matrix is the one place horizontal scroll is expected: the permission column is sticky, roles
scroll. At `md` the matrix switches to one role at a time with a role selector. At `xs` it is
read-only.

The matrix is a real table with `<th scope>` on both axes so a screen reader announces
"Post voucher, Accountant, granted". Cell toggles are checkboxes with full accessible names, never
icon-only.

## 10. Open questions

1. Are custom roles in MVP, or a fixed set of six?
2. Is branch scoping a permission dimension or a separate assignment?
3. Does segregation of duties (cannot approve own document) belong here as a role attribute?
