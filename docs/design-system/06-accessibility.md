# Accessibility

Target: **WCAG 2.2 AA**. This is an all-day keyboard-driven data tool; accessibility here is
primarily about keyboard efficiency and unambiguous figures, and only secondarily about compliance.

---

## 1. Keyboard

- Every interactive element is reachable and operable by keyboard. No mouse-only affordance.
- Logical tab order follows visual order: sidebar → top bar → page head actions → filters → table.
- **Skip to content** link as the first focusable element.
- Global: `Ctrl/Cmd K` global search · `Ctrl/Cmd /` shortcut help · `Esc` closes the top overlay.
- Tables: `↑ ↓` move rows, `Enter` opens the row, `Space` toggles selection, `Home`/`End` jump.
- `LineItemGrid` / `DrCrGrid`: `Tab` moves cell to cell, `Enter` on the last cell adds a row,
  `Ctrl+Backspace` deletes the focused row (with confirm), `Ctrl+Enter` submits the form.
- Entry screens: `Ctrl+S` saves a draft. Posting has **no keyboard shortcut** — it is a deliberate
  click through a confirm dialog.

## 2. Focus

`outline: 3px solid rgba(62,173,114,.24); outline-offset: 2px` on every focusable element, never
removed. Focus is visible on dark surfaces too (switch to a light ring on the hero band).
Modals and drawers trap focus and restore it to the trigger on close.

## 3. Contrast

- Body and figure text meets 4.5:1 against its surface; 9.5px caption text is held to 4.5:1 as well
  (this is why `--muted` is `#64748B`, not lighter).
- Badge text meets 4.5:1 against its tinted background — verified per tone.
- Non-text UI (borders of inputs, focus rings, chart series separations) meets 3:1.
- **Colour is never the only carrier of meaning**: Dr/Cr are separate labelled columns; status
  badges carry text; chart series carry a legend and direct labels; validity carries an icon and a
  message.

## 4. Screen reader semantics

- One `h1` per page (the page title); headings nest without skipping.
- Landmarks: `banner` (top bar), `navigation` (sidebar), `main`, `contentinfo`.
- Tables are real `<table>` with `<caption>` (visually hidden when the panel title serves),
  `<th scope="col">`, and `<th scope="row">` on the identifying cell.
- Sortable headers expose `aria-sort`. Selection checkboxes have per-row labels naming the record.
- Currency cells include an accessible label spelling the amount and its side
  (`Debit 3,458,000 rupees`) when the visual relies on column position.
- Live regions: `aria-live="polite"` for toasts, filter result counts and running totals;
  `aria-live="assertive"` only for a failed post.
- Icon-only buttons have `aria-label`; decorative icons are `aria-hidden="true"`.
- Modals: `role="dialog"`, `aria-modal="true"`, `aria-labelledby` on the heading.

## 5. Forms

- Every control has a visible, programmatically associated label. Placeholder is never a label.
- Required fields are marked visually and with `aria-required`.
- Errors use `aria-invalid` and `aria-describedby`; the `FormErrorSummary` receives focus on a
  failed submit and links to each invalid field.
- Helper text explains format before the user errs (`DD-MM-YYYY`, `Max 2 decimals`).

## 6. Motion and time

- `prefers-reduced-motion` removes all transitions and transforms.
- No session timeout that cannot be extended; a warning appears at 2 minutes with an extend action.
- Toasts persist 5s minimum and errors do not auto-dismiss; all toast content is also reachable in
  the page (a posted voucher appears in the register regardless of the toast).

## 7. Zoom and reflow

Usable at 200% zoom and at 1280×720. Tables reflow per [07-responsive](07-responsive.md) rather
than forcing horizontal page scroll; only the table itself scrolls horizontally.

## 8. Testing gate

Before a screen is done: keyboard-only pass of the primary task · axe-core clean in CI ·
one screen-reader pass (NVDA) per archetype, not per page · contrast verified on tokens, not
screenshots.
