# Access restricted

| | |
|---|---|
| **Route** | `/unauthorized` (and the rendered state of any denied deep link) |
| **Archetype** | — (system state page) |
| **Module / permission** | None |
| **Prototype source** | `ui-prototype/src/App.tsx` (`state-page` route) |
| **Posts to the ledger** | no |

## 1. Purpose

What a user sees when they follow a link into a module their role cannot open. It exists so that a
denied deep link is explained rather than silently redirected — a silent redirect makes users think
the link is broken and generates support noise.

## 2. Anatomy

```
              [ LockKeyhole in a 60px amber well ]
                      Access restricted
     The Salesman role does not have permission to open Chart of Accounts.
                   [ Return to dashboard ]
            Need access? Ask your administrator.  (link opens a request)
```

Centred, `min-height: calc(100vh - 130px)`, inside the normal shell — the sidebar and top bar stay,
so the user can navigate away without going back.

## 3. Components

`PermissionState` (from `packages/ui/src/states`), `Button` (secondary).

## 4. Copy rules

- Name **the role** and **the module**. Never "you do not have access".
- Never reveal whether the record exists. A denied record deep link renders the
  **Not found** state instead ([04-states §11](../../04-states.md)) so that a probe cannot
  distinguish "exists, forbidden" from "does not exist".
- Never offer a retry; retrying cannot change the outcome.

## 5. Behaviour

| Case | Render |
|---|---|
| Module-level permission missing | This page |
| Record belongs to another tenant | **Not found**, never this page |
| Action-level permission missing | Not a page — the control is disabled in place with the reason in its tooltip |
| Session expired | Re-authentication modal over the current page, not this page |

## 6. Accessibility

`h1` is "Access restricted", focus moves to it on render, the lock icon is `aria-hidden` and the
role/module names are in the sentence, not only in the visual.

## 7. Open questions

1. Should "Ask your administrator" create a real access request record, or open a mailto?
2. Do we log denied navigations for the security review, and at what level?
