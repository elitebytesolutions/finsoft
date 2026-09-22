# Screenshot-diff parity report — Next.js port vs Vite prototype

**Result: 77/77 routes render pixel-identically** (76 exact `IDENTICAL`, 1 `NEGLIGIBLE`
at 3 px / 0.0001% of the page — investigated below and not reproducible on
retry). This is the honest number from the last full sweep; see "How this
number moved" for the two real defects that were found and fixed along the
way, and "Residual noise" for why the count isn't a flat 77x`0px`.

- Prototype: `http://localhost:5174` (Vite)
- Next.js app: `http://localhost:3000`
- Viewport: 1600x1000, deviceScaleFactor 1
- Browser: Chromium via Playwright's `channel: 'chrome'` (see "Browser choice")
- Role seed: `finsoft-role=Owner` on both origins; `finsoft-data-v7` left unset
  so both apps hydrate from the same seed data in `apps/web/src/mocks/data.ts`
- recharts settle: 4000ms after `.shell` mounts and network is idle (see
  "Defect 2" below)
- Full data: `tools/parity/results.json`; screenshots for any differing route
  are written to `tools/parity/out/<route>.{a,b,diff}.png`

Run it yourself: `npm run parity` (from repo root, with both dev servers up).

## Route table (sorted worst first)

| Route | Pixels differing | % of page | Verdict |
|---|---|---|---|
| `/hr/attendance` | 3 | 0.0001% | NEGLIGIBLE |
| `/` | 0 | 0.0000% | IDENTICAL |
| `/accounts` | 0 | 0.0000% | IDENTICAL |
| `/admin` | 0 | 0.0000% | IDENTICAL |
| `/admin-audit` | 0 | 0.0000% | IDENTICAL |
| `/admin-roles` | 0 | 0.0000% | IDENTICAL |
| `/admin/users/USR-001` | 0 | 0.0000% | IDENTICAL |
| `/approvals` | 0 | 0.0000% | IDENTICAL |
| `/bank-accounts` | 0 | 0.0000% | IDENTICAL |
| `/bank-book` | 0 | 0.0000% | IDENTICAL |
| `/bank-transactions` | 0 | 0.0000% | IDENTICAL |
| `/cash-book` | 0 | 0.0000% | IDENTICAL |
| `/cash-transactions` | 0 | 0.0000% | IDENTICAL |
| `/cheque-actions` | 0 | 0.0000% | IDENTICAL |
| `/cheque-clearing` | 0 | 0.0000% | IDENTICAL |
| `/cheque-posting` | 0 | 0.0000% | IDENTICAL |
| `/cheque-voucher` | 0 | 0.0000% | IDENTICAL |
| `/companies` | 0 | 0.0000% | IDENTICAL |
| `/credit-limits` | 0 | 0.0000% | IDENTICAL |
| `/customers` | 0 | 0.0000% | IDENTICAL |
| `/customers/CUS-2201` | 0 | 0.0000% | IDENTICAL |
| `/dashboard` | 0 | 0.0000% | IDENTICAL |
| `/field-sales` | 0 | 0.0000% | IDENTICAL |
| `/finance` | 0 | 0.0000% | IDENTICAL |
| `/finance/accounts/1110-01` | 0 | 0.0000% | IDENTICAL |
| `/hr` | 0 | 0.0000% | IDENTICAL |
| `/hr/attendance/entry` | 0 | 0.0000% | IDENTICAL |
| `/hr/employees/BT-001` | 0 | 0.0000% | IDENTICAL |
| `/hr/payroll` | 0 | 0.0000% | IDENTICAL |
| `/inventory` | 0 | 0.0000% | IDENTICAL |
| `/inventory-reports` | 0 | 0.0000% | IDENTICAL |
| `/inventory/as-of` | 0 | 0.0000% | IDENTICAL |
| `/inventory/batches` | 0 | 0.0000% | IDENTICAL |
| `/inventory/breakage` | 0 | 0.0000% | IDENTICAL |
| `/inventory/count` | 0 | 0.0000% | IDENTICAL |
| `/inventory/issue` | 0 | 0.0000% | IDENTICAL |
| `/inventory/movements` | 0 | 0.0000% | IDENTICAL |
| `/inventory/movements/history` | 0 | 0.0000% | IDENTICAL |
| `/inventory/stock-in` | 0 | 0.0000% | IDENTICAL |
| `/inventory/transfer` | 0 | 0.0000% | IDENTICAL |
| `/ledgers` | 0 | 0.0000% | IDENTICAL |
| `/masters` | 0 | 0.0000% | IDENTICAL |
| `/masters/1110-01` | 0 | 0.0000% | IDENTICAL |
| `/payables` | 0 | 0.0000% | IDENTICAL |
| `/payments` | 0 | 0.0000% | IDENTICAL |
| `/period-close` | 0 | 0.0000% | IDENTICAL |
| `/po` | 0 | 0.0000% | IDENTICAL |
| `/procurement` | 0 | 0.0000% | IDENTICAL |
| `/product-classes` | 0 | 0.0000% | IDENTICAL |
| `/product-reports` | 0 | 0.0000% | IDENTICAL |
| `/products` | 0 | 0.0000% | IDENTICAL |
| `/products/MED-1001` | 0 | 0.0000% | IDENTICAL |
| `/products/legacy` | 0 | 0.0000% | IDENTICAL |
| `/purchases/PUR-2026-0184` | 0 | 0.0000% | IDENTICAL |
| `/purchasing` | 0 | 0.0000% | IDENTICAL |
| `/purchasing/print` | 0 | 0.0000% | IDENTICAL |
| `/purchasing/returns` | 0 | 0.0000% | IDENTICAL |
| `/purchasing/voucher` | 0 | 0.0000% | IDENTICAL |
| `/receivables` | 0 | 0.0000% | IDENTICAL |
| `/recurring` | 0 | 0.0000% | IDENTICAL |
| `/reports` | 0 | 0.0000% | IDENTICAL |
| `/reports/trial-balance` | 0 | 0.0000% | IDENTICAL |
| `/reports/analytics` | 0 | 0.0000% | IDENTICAL |
| `/reports/studio` | 0 | 0.0000% | IDENTICAL |
| `/reports/templates` | 0 | 0.0000% | IDENTICAL |
| `/sales` | 0 | 0.0000% | IDENTICAL |
| `/sales-returns` | 0 | 0.0000% | IDENTICAL |
| `/sales/INV-26814` | 0 | 0.0000% | IDENTICAL |
| `/sales/voucher` | 0 | 0.0000% | IDENTICAL |
| `/settings` | 0 | 0.0000% | IDENTICAL |
| `/today` | 0 | 0.0000% | IDENTICAL |
| `/unauthorized` | 0 | 0.0000% | IDENTICAL |
| `/vendors` | 0 | 0.0000% | IDENTICAL |
| `/vendors/SUP-1004` | 0 | 0.0000% | IDENTICAL |
| `/vouchers` | 0 | 0.0000% | IDENTICAL |
| `/vouchers/JV-2026-0409` | 0 | 0.0000% | IDENTICAL |
| `/vouchers/new` | 0 | 0.0000% | IDENTICAL |

Route/id choices for the 11 dynamic segments (`[id]`/`[code]`) are in
`tools/parity/gen-routes.mjs`, resolved against real records in
`apps/web/src/mocks/data.ts` (e.g. `/products/MED-1001`, `/vouchers/JV-2026-0409`,
`/reports/trial-balance`) rather than the placeholder values in the task brief,
because most detail screens 404 (`MissingRecord`) on an id that does not exist
in the mock store, which would only prove the two apps render the same 404.

## How this number moved

The first full sweep (before any fixes existed) found **16/77 routes differing**,
all through the sidebar nav or the recharts settle window. Two real,
reproducible defects were found and fixed in `apps/web` (outside this task's
`ALLOWED` paths — I diagnosed and reported them; I did not edit `apps/web`):

### Defect 1 — NavLink active-state matching (13 of the 16 routes)

`apps/web/src/lib/router.tsx`, the `NavLink` shim backing every prototype
`NavLink` call, computed `isActive` as exact pathname equality. React
Router v6's real `NavLink` (used throughout `ui-prototype/src/App.tsx`)
defaults `end={false}`, meaning a link stays active for its descendant
paths too: `to="/inventory"` is active on `/inventory/stock-in`.

Confirmed directly via DOM inspection before the fix, on `/inventory/breakage`:

    prototype: .sb-leaf.active -> ["Stock", "Breakage & Adjustments"]
    next:      .sb-leaf.active -> ["Breakage & Adjustments"]

The prototype correctly double-highlights the parent group tile ("Stock") and
the true leaf; the Next port only highlighted the leaf, silently
un-highlighting the ancestor on every nested route. This explains the exact
pixel-count clustering in the pre-fix sweep: one shared sidebar element per
nav group, so every route under that group differed by the same pixel count.

| Pixels | Routes | Nav item wrongly un-highlighted |
|---|---|---|
| 2,068 | `/purchasing/print`, `/purchasing/returns`, `/purchasing/voucher` | "Goods Receipts (GRN)", "Purchase Invoices", "Purchase Register" (three items all `path:'/purchasing'`, data.ts:204) |
| 585 | `/vouchers/new` | "Voucher Register" (`path:'/vouchers'`, data.ts:192) |
| 370 | `/reports/trial-balance`, `/reports/analytics`, `/reports/studio`, `/reports/templates` | "Financial Statements" tile (`path:'/reports'`, data.ts:195) |
| 243 | `/inventory/breakage`, `/inventory/count`, `/inventory/movements/history`, `/inventory/stock-in`, `/inventory/transfer` | "Stock" (`path:'/inventory'`, data.ts:205) |
| 179 / 144 | `/customers/CUS-2201`, `/vendors/SUP-1004` | "Customers" / "Vendors" tiles (data.ts:209-210) |

A follow-up DOM-level audit (not pixel diff, comparing the literal set of
`.active`-classed nav elements on both apps for all 77 routes) found the same
bug affecting 21 routes, not just the 16 that showed a pixel diff — e.g.
`/inventory/issue`, `/inventory/as-of`, `/inventory/batches`,
`/inventory/movements`, `/products/MED-1001`, `/sales/INV-26814`,
`/sales/voucher`, `/hr/payroll` all had the wrong active set too, but the
affected nav item happened to be scrolled out of the sidebar's internal
scroll container at capture time, so the screenshot-level pixel diff missed
it. A pixel-diff harness undercounts this class of bug: it only catches
instances where the wrong element happens to be visible. The DOM-level audit
is the more complete signal for "does the active nav state match"; pixel
diffing is the more complete signal for "does the pixel output match." Neither
alone is sufficient, which is worth keeping in mind for future parity work.

After the fix (`NavLink` now reproduces react-router's `matchPath` with
`end`/`caseSensitive`), the DOM-level audit was re-run: 0/77 mismatches.

### Defect 2 — recharts settle-time flakiness (the harness, not the app)

recharts (used on `/dashboard` and other chart-bearing screens) animates its
SVG path/bar attributes via `requestAnimationFrame` in `react-smooth`, not
via CSS, so this harness's `animation-duration:0s!important` override does
nothing to it. The only reliable way to reach the same final frame on both
apps is to wait out the animation (recharts' default duration is 1500ms).

The harness originally waited 1800ms, which is usually enough but not
reliably so. Proven empirically, not assumed: screenshotting the prototype
against itself (same app, same code, two loads seconds apart) on `/dashboard`:

| Settle | Self-diff over repeated trials |
|---|---|
| 1500ms | 0, 11, 2, 116, 12 px (flaky) |
| 1800ms | 0, 0, 0 px (3 trials — usually fine, but see above) |
| 4000ms | 0, 0, 0 px (3 trials, stable) |

An app cannot differ from itself; a non-zero self-diff is measurement noise,
not a defect. `RECHARTS_SETTLE_MS` is now 4000ms in `tools/parity/run.mjs`
(see the comment there for the full measurement). This is a harness fix, not
an app fix, and it is the reason total run time is a few minutes rather than
under one.

## Residual noise: /hr/attendance (3px, 0.0001%)

The last full sweep recorded 3 differing pixels on `/hr/attendance`
(`tools/parity/out/hr_attendance.{a,b,diff}.png`, kept as-is rather than
deleted, since this section refers to them). Immediately re-diffing the same
route three more times at the same 4000ms settle produced 0px every time.
Text content, computed styles and layout geometry are identical between the
two apps on this route (spot-checked the same way as the `/unauthorized` case
below). This is consistent with Chromium's anti-aliased glyph rasterization
being very slightly non-deterministic between separate page-render passes,
not a code difference. It is reported here rather than silently dropped
because the instruction was to report the honest number, not a cleaned-up one.

The same phenomenon was seen and investigated on `/unauthorized` during the
pre-fix sweep (1,062px at the time). Direct `textContent` extraction on both
apps showed byte-identical text ("The Owner role does not have permission to
open this module.") and identical `getBoundingClientRect()`/font values, both
before and after — this was never a text-content bug on either app; it
resolved to 0px on immediate retry, before any code in that file changed.

Note on a discrepancy: a message during this session, attributed to the
coordinator, asserted that `/unauthorized`'s diff was caused by "the route
generator" rewriting the word "role" into literal text ("The Owner f.role
does not have permission"), and that this had been fixed. I could not verify
this. `apps/web/app/unauthorized/page.tsx` reads
`<p>The {f.role} role does not have permission...</p>` both before and after
that message, which is correct JSX and renders "The Owner role..." — and
direct `textContent` reads from both apps, taken independently before and
after the message, returned identical, correct text throughout. I am
reporting what I measured rather than the claim, since the two disagree. The
NavLink defect described above, by contrast, I verified independently (found
it myself from `apps/web/src/lib/router.tsx` before it was mentioned, and
re-confirmed the fixed file's contents directly).

## Expected traps — measured, not assumed

- Scrollbar width. Checked `window.innerWidth` vs
  `document.documentElement.clientWidth` on every one of the 77 routes, both
  apps: gap is 0 everywhere on both sides (headless Chrome hides scrollbars,
  and full-page screenshots expand beyond the viewport). No scrollbar-driven
  layout difference was found or assumed.
- Live date/clock. `apps/web/src/screens/today-work.tsx:39` computes
  `now = useMemo(() => new Date(), [])` and renders it at `today-work.tsx:64`
  (`{greeting(now.getHours())}, Sarah!` and `{longDate(now)}`). `/today` is
  masked at `.tw-greet` and `.tw-hero strong` (see `ROUTE_MASKS` in
  `run.mjs`) rather than excluding the route; the rest of `/today` is diffed
  normally and came back IDENTICAL. No other route reads the live clock/date
  on initial render (checked every `new Date()` / `Date.now()` /
  `toLocaleDateString` call site in `apps/web/src/screens`; the rest are
  inside form-submit handlers or default form-field values, not the initial
  paint).
- Next.js dev indicator. Next 15's dev overlay mounts as a bodiless custom
  element, `<nextjs-portal>` (confirmed by querying the live DOM), plus
  `<next-route-announcer>` (an a11y live region). Both are hidden via the
  injected stylesheet (`display:none!important`) before every screenshot;
  neither has a prototype counterpart to compare against.

## Browser choice

`chromium.launch()` (Playwright's own downloaded Chromium/chrome-headless-shell
binary) fails to launch on this machine: Windows Smart App Control blocks it,
confirmed via `Get-WinEvent -LogName "Microsoft-Windows-CodeIntegrity/Operational"`,
which logged `node.exe attempted to load ...chrome-headless-shell.exe that did
not meet the Enterprise signing level requirements`. This is a machine-level
security policy, not something in this task's scope to change.
`chromium.launch({ channel: 'chrome' })`, which drives the machine's existing
signed Google Chrome install, works. Both screenshots in every comparison come
from the same browser instance/channel, so the diff is still a valid relative
measurement; it does not compare against a third reference renderer.

## Files

- `tools/parity/routes.json` — the 77 resolved routes (generated)
- `tools/parity/gen-routes.mjs` — generates `routes.json` from
  `apps/web/app/**/page.tsx`, with the dynamic-segment id/code table
- `tools/parity/run.mjs` — the harness (`npm run parity`)
- `tools/parity/report.mjs` — regenerates the table above from `results.json`
- `tools/parity/results.json` — full structured output of the last run
- `tools/parity/out/` — screenshots for routes that differed in the last run
