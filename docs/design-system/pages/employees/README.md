# Employees

| | |
|---|---|
| **Route** | `/hr` |
| **Archetype** | A — Register |
| **Module / permission** | HR & Payroll · `HR & Payroll` · create needs `master:create` |
| **Prototype source** | `ui-prototype/src/App.tsx` (`HR`), `src/master-form.tsx` (`EmployeeFormModal`) |
| **Posts to the ledger** | no — payroll posts from `/hr/payroll` |

## 1. Purpose

The staff directory: who works here, in what role, at what branch, on what salary, and whether they
are in today.

## 2. Anatomy

```
PageHead   "HR & payroll" · "Bring attendance, compensation and sales performance into one
            workspace." · [Export] [+ Add employee]
KpiRow     Total employees · On leave · Payroll (current month) · Field sales team
FilterBar  search · department · designation · branch · employment type · status
DataTable  Employee ID · Employee · Designation · Department · Branch · Gross salary · Today · Status · Actions
Footer     showing · payroll total · pager
Modal      Add / edit employee
```

## 3. Components

`KpiRow` · `FilterBar` · `DataTable` · `Modal` (employee form) · `StatusBadge` · `Avatar` ·
`ExportMenu` · `ConfirmDialog`.

## 4. Columns

| Column | Align | Format | Priority |
|---|---|---|---|
| Employee ID | left | tabular, links to `/hr/employees/:id` | 1 |
| Employee | left | avatar + name (700) + 9.5px CNIC (masked) | 1 |
| Designation / Department | left | text | 2 |
| Branch | left | text | 3 |
| Gross salary | right | money; **hidden without `hr:view-salary`** | 2 |
| Today | left | attendance chip: Present `good` · Absent `danger` · Leave `info` · Off `neutral` | 2 |
| Status | left | Active `good` · Notice `warn` · Left `neutral` | 2 |
| Actions | right | View · Attendance · Payslips · Edit · Deactivate | 1 |

## 5. Employee form fields

Employee ID · Name · CNIC · Father/husband name · Date of birth · Contact · Address ·
Designation · Department · Branch · Employment type · Joining date · Reporting to ·
**Salary components** (basic, allowances by type, deductions) · Bank account for salary ·
Sales role flags (booker / deliveryman / salesman) · Status and leaving date.

Salary components are a repeatable group, each with a name, type (earning/deduction), amount or
percentage, and a taxable flag — because payroll posting depends on the split, not on one gross
figure.

## 6. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| Add employee | primary | `master:create` | no | Creates the record |
| Edit | row | `master:edit` | salary change: **yes, effective-dated** | Salary history is preserved |
| Deactivate / mark leaver | row | `master:edit` | **yes, with a leaving date** | Excluded from future payroll; history and payslips remain |
| Delete | — | — | — | **Never offered** |

## 7. Financial rules

- Salary changes are **effective-dated** and never restate a posted payroll run.
- Salary figures are visible only with `hr:view-salary`; exports for other roles omit the column
  rather than blanking it.
- An employee with posted payroll is never deleted.
- CNIC and bank account are personal data: masked in lists, revealed on the record with an audited
  reveal action.

## 8. States

Empty with an import offer; filtered empty; an employee with no salary structure carries a `warn`
chip because payroll would skip them silently.

## 9. Responsive · 10. Accessibility

`xl` hides Department · `md` filter sheet · `xs` card list.
Masked CNIC has an accessible label stating it is masked; the attendance chip carries text.

## 11. Open questions

1. Is payroll monthly only, or are daily-wage and commission-only staff supported?
2. Are leave balances tracked, and where?
3. Who may see salary — Owner only, or an HR role?
