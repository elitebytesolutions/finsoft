# Attendance

| | |
|---|---|
| **Route** | `/hr/attendance` |
| **Archetype** | A — Register (+ per-person timeline) |
| **Module / permission** | HR & Payroll · `HR & Payroll` · marking needs `hr:attendance` |
| **Prototype source** | `ui-prototype/src/attendance.tsx` (`SalesmanAttendance`) |
| **Reference frame** | `ui-prototype/design/attendance listings page .png` |
| **Posts to the ledger** | no — it feeds payroll, which posts |

## 1. Purpose

Who is in, who is out, and — for field staff — where they went. Attendance is the input to payroll,
so it must be complete and auditable before a run.

## 2. Anatomy

```
PageHead   "Salesmen Attendance" · [date v] [branch v] [Export] [+ Mark attendance]
KpiRow     Present · Absent · On leave · Late · (field) Stops covered
Grid       [ Roster ]                          [ Selected person ]
             employee · status chip · in/out ·   Today's Route · Visited Locations ·
             hours · route                       Today's Attendance Timeline · Today's Notes
Table      "Saved Attendance Records" — Date · Employee · Status · Check-in · Check-out · Hours ·
           Route · Marked by · Actions
```

## 3. Components

`KpiRow` · `DataTable` · `Timeline` (visits) · `Panel` · `StatusBadge` · `DateField` ·
`MapPreview` (optional, page-local) · `ExportMenu` · `ConfirmDialog`.

## 4. Status vocabulary

`Present` `good` · `Absent` `danger` · `Leave` `info` · `Half day` `warn` · `Late` `warn` ·
`Off` `neutral` · `Holiday` `neutral`. One list, used identically in payroll.

Hours are computed from check-in/out and shown to one decimal; a missing check-out shows
`Open` in `warn`, never a fabricated time.

## 5. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| Mark attendance | primary | `hr:attendance` | no | `/hr/attendance/entry` |
| Edit a record | row | `hr:attendance` | **yes, reason required** | Audited; **blocked once payroll for that month has run** |
| Bulk mark (roster) | secondary | `hr:attendance` | yes, with the count | Marks a common status for selected employees |
| Export | secondary | `Reports` | no | Period register for payroll evidence |

## 6. Rules

- Attendance for a month that payroll has already processed is **locked**; the row explains why and
  points at a supplementary payroll run instead.
- Every edit records who changed what, from what, to what, and why.
- Field visit data (locations, photos, notes) is evidence: it is append-only and cannot be edited,
  only annotated.

## 7. States

No records for the date ("Attendance not marked for 16 Sep 2026 — 12 employees pending"), which is a
`warn` state, not an empty one, because unmarked attendance is a payroll risk.
Locked month; partial day in progress; missing check-out.

## 8. Responsive · 9. Accessibility

`md` the detail panel moves below the roster · `sm` the roster is the primary view and marking is
supported (this is a mobile-appropriate task) · `xs` card list with a status selector per row.
Status chips carry text; the visit timeline is a real ordered list.

## 10. Open questions

1. Is attendance captured by device (biometric, app check-in) or entered by a supervisor?
2. Are geo-locations stored, and what is the retention and privacy policy? (Security-guardian.)
3. How do public holidays and branch-specific off days get configured?
