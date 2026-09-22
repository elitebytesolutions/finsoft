# Payroll

| | |
|---|---|
| **Route** | `/hr/payroll` |
| **Archetype** | B — Document entry (batch run) |
| **Module / permission** | HR & Payroll · `HR & Payroll` · posting needs `payroll:post` (Owner / Accountant) |
| **Prototype source** | `ui-prototype/src/payroll.tsx` (`PayrollPage`) |
| **Reference frame** | `ui-prototype/design/payroll generation page .png` |
| **Posts to the ledger** | **yes** — salary expense, deductions, payable, advances recovery |

## 1. Purpose

Run the month's payroll: compute from attendance and salary structures, review every line, then post
once. It is a batch posting, so the review step is the whole design.

## 2. Anatomy

```
DocHeadBar  "Employee Payroll" · month selector · [Recalculate] [Save draft] [Post payroll]
KpiRow      Employees in run · Gross · Deductions · **Net payable** · Advances recovered
FilterBar   department · branch · employment type · status (included / excluded / error)
Table       "Payroll Preview"
            ☐ · Employee · Designation · Department · Days · Basic Salary · Allowances ·
            Deductions · Advance recovery · **Net Salary** · Status · Actions
Footer      totals row (the figures that will post)
LedgerPreview Salary expense · Allowances · Deductions payable · Advances · Net payable
```

## 3. Components

`MonthSelector` · `KpiRow` · `DataTable` (selectable, with an expandable per-employee breakdown) ·
`LedgerImpactCard` · `ConfirmDialog` · `IdempotencyGuard` · `StatusBadge` · `ExportMenu`
(bank transfer file, payslips).

## 4. Row rules

- Each row expands to show the component breakdown: every earning and deduction by name, with the
  rule that produced it (structure, attendance proration, advance schedule).
- Days present comes from attendance and is **not editable here** — a wrong day count is fixed in
  attendance, and the row links there.
- A row can be **excluded** from the run with a reason; exclusion is audited and shown in the totals.
- An employee with no salary structure appears as an error row, not silently absent.
- Manual adjustments are a named component with a reason, never an edit of a computed figure.

## 5. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| Recalculate | secondary | `HR & Payroll` | no | Recomputes from current attendance and structures; discards nothing the user typed without saying so |
| Save draft | secondary | `HR & Payroll` | no | Draft run; no ledger effect |
| **Post payroll** | primary | `payroll:post` | **yes — employee count, gross, deductions, net, period, and that payslips become final** | Posts one journal for the run; payslips become available |
| Export bank file | secondary | `payroll:post` | no | Bank transfer file for net payments |
| Payslips | secondary | `hr:view-salary` | no | PDF per employee |

## 6. Financial rules

- **One posted run per month per company.** A second attempt is refused; corrections are a
  supplementary run or a reversal, both linked to the original.
- The run posts a single journal produced by the posting engine from a payroll event; this module
  never constructs lines.
- Posting is idempotent: one key per run.
- Closed period refuses the post, including for a scheduled job.
- Once posted, attendance for that month locks (see [attendance](../attendance/)).
- Net payable sits as a liability until paid; payment is a separate posting from `/payments`.

## 7. States

- Error rows (no structure, no attendance, negative net) block posting and are listed in a summary
  above the table.
- Already posted: the page becomes a read-only record of the run with payslip and export actions.
- Recalculate after edits: a diff banner naming what changed.
- Post failure: nothing posted, the run stays a draft, the same key is reused on retry.

## 8. Responsive · 9. Accessibility

`lg` the table scrolls with Employee sticky · `md` KPI 2×2 · `sm` and below read-only — payroll is
not a phone task.
The totals row is a `<tfoot>` with a caption tying it to the posting preview; the confirm dialog
restates the totals as text.

## 10. Open questions

1. Are EOBI, social security and income tax withholding computed in MVP, and by whose rules?
2. Is there an approval step between draft and post for payroll specifically?
3. How are mid-month joiners and leavers prorated — calendar days or working days?
