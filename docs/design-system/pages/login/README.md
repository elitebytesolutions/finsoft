# Login

| | |
|---|---|
| **Route** | `/login` |
| **Archetype** | — (auth screen; none of A–I fits. Closest relative is a single-purpose form with no register, no ledger, no permission gate on itself — it is the one screen every session starts before permission exists) |
| **Module / permission** | none — unauthenticated by definition |
| **Prototype source** | none. `ui-prototype/` has no login screen; the prototype starts already "signed in" with a role switcher. This page is new |
| **Reference frame** | none |
| **Posts to the ledger** | no |
| **Owner** | frontend-engineer (M1-W lane) |

## 1. Purpose

The one screen every person sees before anything else. A person who knows their tenant code,
email and password gets into their tenant's workspace; anyone else gets a generic refusal that
never confirms which of the three was wrong. It is also where a session that expired elsewhere
in the app lands the user back, with an explanation.

## 2. Anatomy

```
Centred single-column card, max-width ~420px, on a plain surface (no sidebar, no top bar —
this page renders outside <Shell>).

  Brandmark + "Finsoft"
  h1  "Sign in"
  [ session-expired banner, if applicable ]
  [ form-level banner: invalid credentials / rate-limited / network error ]
  Field  Tenant code     (TextInput, autoFocus)
  Field  Email           (TextInput type=email)
  Field  Password        (TextInput type=password)
  Button primary, full width  "Sign in" / "Signing in…" while submitting
  small print: "Access is invite-only. Contact your administrator for an account."
```

No "Remember me". No "Forgot password" link and no "Sign up" link — both deliberately absent
(PO decision, invite-only provisioning; a password-reset flow is a separate, later page with its
own document). No footer nav, no prototype banner (see §6).

## 3. Components

`TextInput` + `Field` and `Banner` (all three requested from the design-system agent as part of
this task — none existed in `packages/ui` before it; see `02-components.md` §C1/C2/F), `Button`
(kit, `primary`, full width, its new `busy` prop while submitting — spinner in, pointer-events
off, label unchanged — plus this page's own label swap to "Signing in…" text, since `busy` does
not itself change the label).

No page-local component. `Field`+`TextInput` split id ownership: the page passes the same string
as `Field`'s `htmlFor` and `TextInput`'s `id` (see the design-system agent's note in
`packages/ui/src/components.tsx`) and derives each error message's id as `${id}-error` to wire
`aria-describedby` itself — `Field` does not clone or inspect its children.

## 4. Data

No table, no KPI. Three fields:

| Field | Control | Notes |
|---|---|---|
| Tenant code | `TextInput` | plain text, not a picker — a person types their own tenant's code, they do not search someone else's |
| Email | `TextInput type=email` | |
| Password | `TextInput type=password` | never echoed, no reveal toggle in this iteration (open question §11) |

Client-side validation is presence-only (all three required) plus a plain email-shape check, for
speed of feedback. It is not authoritative and never invents a rule the server does not also
enforce — `packages/validation` has no login schema yet (the auth lane owns it); when one lands,
this page adopts it in place of the inline presence check, not alongside it.

## 5. Actions

| Action | Kind | Permission | Result |
|---|---|---|---|
| Sign in | primary, `type=submit` | none (unauthenticated) | `POST /api/auth/login`. 200 → store access token in memory, navigate to `next` query param or `/dashboard`. 401 → generic invalid-credentials banner. 429 → rate-limited banner with the `Retry-After` seconds. Network failure → network-error banner |

Submit is disabled the instant it is pressed and stays disabled until the request settles
(success navigates away; failure re-enables it) — repeat clicks cannot fire two login requests.
Enter in any field submits the form (native `<form onSubmit>`, no keydown interception needed).

## 6. States

| State | Trigger | Copy |
|---|---|---|
| Idle | first paint, or after a failed attempt | fields empty except what the user typed; no banner |
| Submitting | after Sign in is pressed, before a response | button reads "Signing in…" and is disabled; fields stay editable-looking but the form is inert |
| Invalid credentials | 401 from `/api/auth/login` | banner, `danger` tone: **"Incorrect tenant code, email or password."** — never names which field, so a bad guess cannot be narrowed by trial |
| Rate-limited | 429 | banner, `warn` tone: **"Too many attempts. Try again in {n}s."**, `n` from the `Retry-After` header, counting down; submit stays disabled until it reaches zero |
| Network error | fetch throws / times out | banner, `danger` tone: **"Could not reach the server. Check your connection and try again."** with a `Try again` action that just re-enables the form — it does not retry automatically |
| Session expired | arrived via a client-side redirect from an expired session (`?next=` present and a `?reason=expired` marker, or equivalent app-context flag) | banner, `info` tone, above the form: **"Your session ended. Sign in again to continue."** |
| Success | 200 | no visible state — immediate navigation, nothing to flash |

This page has no empty/loading-skeleton/partial state in the `04-states.md` sense — it has
nothing to load. It has no permission-denied state — it is reachable by definition without one.

## 7. Financial rules on this page

None directly — it posts nothing and shows no figure. The one rule that does apply: this screen
must never expose which of tenant code / email / password was wrong (rule 9/10 in spirit — an
authentication oracle is a tenant-enumeration and account-enumeration vector, not merely a UX
nicety), and must never place the access or refresh token anywhere JavaScript-readable persists
across a reload (ADR-0009: refresh in an HttpOnly cookie the page never touches; access token
in memory only, gone on a hard reload by design — restored by the silent-refresh-on-load call
the API client makes before this page (or any page) commits to showing a logged-out state).

## 8. Responsive

Single column at every width; the card narrows to fill the viewport with 16px side gutters below
480px and stays at its max-width above that. No layout change at any breakpoint beyond that.

## 9. Accessibility

- `h1` is "Sign in"; the brandmark is decorative (`aria-hidden`).
- Each field's label is a real `<label htmlFor>`; the tenant-code field is focused on mount
  (via its `id`, not an `autoFocus` prop — `TextInput` has none) so keyboard-only entry starts
  immediately.
- Tab order: tenant code → email → password → Sign in. No tabbable decorative element.
- **Deviation from the intent above, recorded rather than silently left inconsistent:** the kit's
  delivered `Banner` (`packages/ui/src/components.tsx`) always renders `role="status"` (an
  implicit *polite*, non-interruptive live region), for every tone — it does not vary by tone as
  first drafted here. That is deliberately correct for a standing, non-urgent notice (the
  prototype banner this same component serves elsewhere), and still adequate for this page — a
  screen reader still announces the banner text once, unprompted — but a failed login attempt is
  arguably urgent enough to interrupt, which `role="alert"` (assertive) would do and `status`
  does not. Left as `status` rather than forked into a one-off `role="alert"` wrapper for just
  this page; revisit with the design-system agent if this is felt in practice (open question §11).
- The rate-limit countdown updates the banner text; it is not re-announced every second
  (`aria-live="off"` on the counting number specifically, inside the already-announced banner)
  so it does not spam
  the screen reader once per second.
- Sufficient contrast in both the light and (if the kit's tokens define one) dark scheme; focus
  ring visible on every control including the submit button.
- No autocomplete is disabled: `autoComplete="username"` / `"current-password"` on the relevant
  fields so a password manager can fill them, because typed-fast, all-day, invite-only accounts
  are exactly the case a password manager should be handling.

## 10. Deviations from the prototype

Not applicable — no prototype source (§Prototype source above).

## 11. Open questions

1. Should password have a reveal toggle? Left off for this increment; low risk to add later
   without changing the field's contract.
2. Does "tenant code" need a typeahead against known codes for a multi-tenant person, or does
   every person only ever type one code in practice? Left as plain text per ADR-0023 §1 ("a form
   field, not a subdomain, not a picker") until product feedback says otherwise.
3. Lockout UI: ADR-0009/ADR-0023 describe server-side lockout and rate limiting; this page only
   renders whatever the server returns (429 + Retry-After) and does not itself decide when a user
   is "locked out" versus merely rate-limited — confirm the auth lane's 401 vs 429 boundary once
   `/api/auth/login` is real, since today this is built and tested against the fixed contract in
   the task brief, not against a running implementation.
4. Should a failed login attempt's banner interrupt (`role="alert"`) rather than merely announce
   (`role="status"`, what the kit's `Banner` actually does today, per §9)? Raise with the
   design-system agent if this is felt in practice — it is a one-line change in one shared
   component, not a per-page fork.
