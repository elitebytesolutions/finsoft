---
name: design-system-review
description: Audit FinSoft UI code for drift from the design system — raw values instead of tokens, forked or one-off components, wrong status tones, Dr/Cr colour misuse, missing states, inaccessible controls. Use before merging frontend work, when reviewing a PR that touches apps/web or packages/ui, or when screens have started to look subtly inconsistent.
---

# Design system review

Drift is cumulative and quiet. Each individual shortcut looks reasonable; thirty of them
are a product that no longer looks like one system. Review against
`docs/design-system/` — specifically `08-governance.md`, which lists the violations.

## Run the cheap checks first

Raw hex outside the token files (`kit.css` is grandfathered debt, so exclude it):

```bash
grep -rniE "#[0-9a-f]{3,8}" apps/web/src apps/web/app packages/ui/src \
  --include=*.tsx --include=*.ts --include=*.css \
  | grep -v "packages/ui/src/tokens/" \
  | grep -v "packages/ui/src/styles/kit.css"
```

Inline style objects carrying design decisions:

```bash
grep -rn "style={{" apps/web/src apps/web/app --include=*.tsx
```

Kit components reimplemented instead of imported:

```bash
grep -rniE "className=\"[^\"]*(btn|badge|panel|kpi|modal|table-wrap)" apps/web/src/screens
```

A hit is not automatically a violation — `style={{backgroundImage: ...}}` for a
data-driven image is fine. A hit that encodes a colour, a size or a spacing is.

## Then read for the things grep cannot see

**Forked components.** Someone needed a table with one extra affordance, copied `Table`
into their screen and diverged. Look for kit class names in feature files. The fix is to
extend the kit component, not to keep the fork.

**Status tone drift.** `01-foundations.md` section 1.4 fixes five tones, and each page
document fixes the mapping for its own statuses. "Pending approval" is `warn` on every
screen or on none. Check the page document, not the neighbouring screen.

**Dr/Cr misuse — the one that matters most.** `--money-debit` and `--money-credit` carry
accounting meaning. If a screen uses the success tone for a debit or the danger tone for a
credit, it is telling the user that one side of a balanced entry is good news. Reject it.

**Figures.** Right-aligned? `tabular-nums`? Zero as an em dash? Negative in
`--money-negative` rather than a generic red? Any animation on a number at all?

**States.** Open the page document and check all four are implemented, not just the happy
path. A screen with no empty state is unfinished.

**Accessibility.** `06-accessibility.md`: focus visible, keyboard reachable, inputs
labelled, icon-only controls have `aria-label`, contrast holds, motion respects
`prefers-reduced-motion`.

**Responsive.** `07-responsive.md`. Tables have a column priority order for narrow
viewports; check the right columns survive.

## Parity, when a prototype screen is involved

`apps/web` was ported from `ui-prototype/` and must still render identically:

```bash
npm run prototype     # :5174
npm run dev           # :3000
npm run parity        # writes tools/parity/report.md
```

A non-zero diff is a defect. Do not raise the threshold to make the report green.

## Reporting

Group findings by severity and name the file and line for each:

1. **Blocking** — financial-meaning violations (Dr/Cr, status tone, a figure rendered as
   posted when it is not), accessibility failures, a forked kit component.
2. **Should fix** — raw values, missing states, responsive breakage.
3. **Note** — inconsistencies that need a decision from the design-system owner.

Say what is *correct* too. A review that only lists faults tells the author nothing about
which of their choices to keep.
