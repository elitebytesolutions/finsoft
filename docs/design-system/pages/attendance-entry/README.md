# Attendance entry

| | |
|---|---|
| **Route** | `/hr/attendance/entry` |
| **Archetype** | B — Document entry (non-financial) |
| **Module / permission** | HR & Payroll · `HR & Payroll` · `hr:attendance` |
| **Prototype source** | `ui-prototype/src/attendance-entry.tsx` (`AttendanceEntry`) |
| **Reference frame** | `ui-prototype/design/attendance detail page .png` |
| **Posts to the ledger** | no |

## 1. Purpose

Record one person's day: check-in, stops, notes, photos, check-out. Built for a supervisor with a
phone in a van, not for a desk — this is the one entry screen that is **mobile-first**.

## 2. Anatomy

```
DocHeadBar   "Attendance" · employee · date · [Save]
StatusRow    [ Present ] [ Absent ] [ Leave ] [ Half day ] [ Off ]   (big targets)
TimeFields   Check-in · Check-out · Hours (computed, read-only)
RouteCard    "Next Stop Details" — planned stop, address, ETA, [Arrive] [Skip]
StopsTable   Time · Type · Location · Note · Photo
Notes        free text, timestamped, append-only
```

## 3. Components

`SegmentedControl` (status, large touch targets) · `TimeField` · `FormSection` ·
`Timeline` (stops) · `PhotoCapture` (page-local) · `Textarea` · `ConfirmDialog`.

## 4. Rules

- Status is chosen first and drives which fields are relevant: `Absent` and `Leave` hide the time
  and stop fields entirely rather than disabling them.
- Check-out cannot precede check-in; hours are computed, never typed.
- Stops, photos and notes are **append-only** — a recorded stop can be annotated but not deleted,
  because it is field evidence.
- A leave status requires a leave type from a controlled list.

## 5. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| Save | primary | `hr:attendance` | no | Creates or updates today's record |
| Arrive / Skip stop | inline | `hr:attendance` | skip: yes, reason | Appends to the timeline with a timestamp |
| Add note / photo | secondary | `hr:attendance` | no | Appends |
| Close day | primary | `hr:attendance` | **yes** | Sets check-out and freezes the record for edits without a reason |

## 6. States

Offline: the screen keeps working and queues the record, showing `Saved locally — will sync`; it
never claims a server save it did not get. Duplicate entry for the same employee and date is
detected and offered as "open the existing record" rather than creating a second one.
A month locked by payroll is read-only with that reason.

## 7. Responsive · 8. Accessibility

**Mobile-first**: single column, 44px+ targets, status buttons full width at `xs`, sticky save.
At `lg` and above the same layout is centred at 640px rather than stretched.
Status buttons are a radio group with text labels; photo capture has a file-input fallback;
computed hours are `aria-live`.

## 9. Open questions

1. Is offline capture in MVP, and what is the sync conflict rule?
2. Are photos required for certain stop types?
3. Does the salesman mark their own attendance, or only a supervisor?
