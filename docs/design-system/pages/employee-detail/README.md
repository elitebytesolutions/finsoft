# Employee detail

| | |
|---|---|
| **Route** | `/hr/employees/:id` |
| **Archetype** | F — Master record |
| **Module / permission** | HR & Payroll · `HR & Payroll` · salary needs `hr:view-salary` |
| **Prototype source** | `ui-prototype/src/detail-pages.tsx` (`EmployeeDetail`) |
| **Posts to the ledger** | no |

## 1. Purpose

One employee: personal and employment details, attendance, payroll history, advances, and — for
field staff — sales performance.

## 2. Anatomy

```
Breadcrumbs  HR & Payroll > Employees > Tanvir Hasan
RecordHeader avatar · name (h1) · employee ID · designation · [Active] · [Mark attendance] [Edit] [More v]
KpiRow       Gross salary · Days present (month) · Last payslip · Advances outstanding
Tabs         Overview · Attendance · Payroll · Advances · Performance · Documents · Activity
  Overview   DefinitionGrid: employment and personal details, salary structure (permission-gated)
  Attendance Date · Day · Check-in · Check-out · Hours · Status
  Payroll    Month · Gross · Allowances · Deductions · Net pay · Voucher · Status
  Advances   Date · Amount · Recovered · Outstanding · Voucher
  Performance (field staff) targets, achievement, collections, route coverage
  Documents  contract, CNIC copy, agreements — with an audited reveal
  Activity   audit timeline
```

## 3. Components

`RecordHeader` · `KpiRow` · `Tabs` · `DefinitionGrid` · `DataTable` · `AllowanceTable` ·
`Timeline` · `AttachmentList` · `Modal` (edit) · `StatusBadge`.

## 4. Formatting

| Figure | Rule |
|---|---|
| Gross / Net pay | money, right; `hr:view-salary` gated |
| Allowances / Deductions | separate columns, never netted |
| Days present | count with the month named |
| Advances outstanding | money; links to the recovery schedule |

Payroll rows link to the payroll voucher that posted them, so a payslip can always be traced to a
journal entry.

## 5. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| Mark attendance | primary | `hr:attendance` | no | `/hr/attendance/entry` for this employee |
| Edit | secondary | `master:edit` | salary change: **yes, effective-dated** | Employee form |
| Download payslip | row | `hr:view-salary` or self | no | PDF |
| Record advance | overflow | `payment:create` | **yes** | `/payments` as an employee advance |
| Deactivate | overflow | `master:edit` | **yes, with a leaving date** | Excluded from future payroll |

## 6. Financial rules

- Payroll history is immutable. A correction is a supplementary or reversing payroll run, linked
  from the original month's row.
- Advances are real postings against the employee's account, recovered through payroll deductions;
  the outstanding figure is server-computed from those postings.
- Salary structure changes are effective-dated and never alter a posted run.

## 7. States

Not found / other tenant → shared Not found. No salary structure → a `warn` banner explaining the
employee will be skipped by payroll. Self-service view (an employee viewing their own record) hides
other employees' comparators and shows only their own figures.

## 8. Responsive · 9. Accessibility

`md` KPI 2×2, definition grid 4 → 2 · `sm` tabs become a select · `xs` card lists.
Personal data reveals are buttons with clear labels; masked values state that they are masked.

## 10. Open questions

1. Is employee self-service in scope, and if so which tabs are visible?
2. Are attendance corrections allowed after payroll has run for that month? (Should be: no.)
3. Where do commissions accrue — payroll, or a separate payable?
