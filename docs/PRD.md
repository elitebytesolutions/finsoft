# PRODUCT REQUIREMENTS — FinSoft ERP

**Status:** v1 — Factory Constitution v1
**Authority:** LEVEL 2. Scope changes require Product Owner approval. Nothing here may override [NON_NEGOTIABLES.md](NON_NEGOTIABLES.md).

---

## 1. What we are building

FinSoft is a **multi-tenant financial and distribution ERP** for trading and distribution businesses, replacing a legacy desktop accounting system currently in use at Bhatti Traders.

It is an accounting system first and an operations system second. Every operational flow — a delivery, a stock adjustment, a cheque handed over a counter — terminates in a correct journal entry. If a feature cannot be posted correctly, it does not ship.

### The one-sentence definition

> A tenant-isolated, double-entry accounting core with inventory, procurement, sales, banking, tax and reporting built on top of it — where the ledger is always right and every number on screen can be traced to a posting.

---

## 2. Who it is for

| Persona | What they do | What they need most |
|---------|--------------|---------------------|
| **Business Owner** | Reads results, approves limits, decides | Trustworthy P&L, receivables ageing, stock value, cash position |
| **Accountant** | Vouchers, reconciliation, period close, filings | Fast entry, correct ledgers, trial balance that balances, clean close |
| **Cashier / Teller** | Receipts, payments, cheques, cash book | Speed, few clicks, no ambiguity, no accidental double-post |
| **Storekeeper** | GRN, issues, transfers, physical count | Barcode-first, batch/expiry visible, offline-tolerant printing |
| **Sales Staff** | Quotations, orders, invoices, returns | Customer balance and credit limit at the point of decision |
| **Purchase Officer** | Demand, PO, GRN, supplier invoices | Supplier pricing history, pending PO visibility |
| **Auditor / Compliance** | Verification, tax filing, statutory reports | Immutable history, complete audit trail, exportable evidence |
| **System Administrator** | Users, roles, periods, configuration | Granular permissions, safe period controls, no accidental power |

### Deployment model

Multi-tenant SaaS. Bhatti Traders is tenant #1 and the pilot. The product must be sellable to a second trading business without a code fork — differences are configuration (chart of accounts, numbering, document layouts, tax profile, roles, posting-rule variants).

---

## 3. Context: what we are replacing

The legacy system's failures are the design brief. These are not to be reproduced:

| Legacy problem | FinSoft requirement |
|----------------|---------------------|
| `MAX(id)+1` numbering, duplicates under concurrency | Server/DB-side sequences, unique constraints |
| Missing foreign keys, orphaned rows | FK everywhere possible, `ON DELETE RESTRICT` |
| Denormalised names copied into transactions | Reference by ID; snapshot fields only for printing |
| `MUSER`/`MTIME` last-writer-wins "audit" | Append-only, hash-chained audit log |
| Records edited in place after posting | Immutable posted records; reverse + re-enter |
| Hard deletes of transactions | Deletion forbidden; status-based lifecycle |
| Balances stored as mutable columns | Ledgers are truth; caches are reconciled |
| Reports containing their own correction logic | Reports read the ledger; no hidden adjustments |
| Single-user assumptions, no roles | Atomic permissions, per-tenant roles |
| No fiscal period control | Period open/closed/locked, enforced at the database |
| Float money | `numeric` + decimal arithmetic |

Migration from the legacy data set is a first-class deliverable, not an afterthought — see §8.

---

## 4. Functional scope

### 4.1 Platform

- **Identity** — login, password policy, MFA for privileged roles, session management, lockout, password reset.
- **Tenants** — tenant provisioning, tenant settings, fiscal calendar, base currency, branding, feature flags.
- **RBAC** — atomic permission catalogue, per-tenant roles, user–role assignment, permission audit.
- **Audit** — append-only log, hash chain, audit viewer with filters, export.
- **Administration** — users, roles, numbering series, document templates, configuration, backups status.

### 4.2 Accounting core *(the first milestone)*

- **Chart of Accounts** — hierarchical, typed (asset/liability/equity/income/expense), control accounts flagged, per-tenant, template-seeded.
- **Journal vouchers** — manual JV entry, multi-line, balanced, attachments, approval where configured.
- **General ledger** — account ledger with running balance, drill-down to source document.
- **Trial balance** — any date range, any level of the account tree, always balanced.
- **Fiscal periods** — open/close/reopen/lock, per-period status, close checklist.
- **Reversal** — reverse any posted entry with full traceability.
- **Opening balances** — structured load, validated, balanced, auditable.

### 4.3 Cash and banking

- Cash receipts and payments; cash book.
- Bank accounts; bank receipts and payments; bank book.
- **Cheque lifecycle** — received / issued → deposited → cleared / dishonoured / cancelled / post-dated, each state posting correctly.
- Bank reconciliation against statement.
- Petty cash / imprest.

### 4.4 Customers and receivables

- Customer master: categories, territory, price list, credit limit, credit days, tax profile, contacts, addresses.
- Customer ledger; ageing; statements.
- Receipt allocation against invoices (FIFO, manual, on-account).
- Credit limit enforcement with an audited override permission.
- Customer balance confirmation and dispute notes.

### 4.5 Vendors and payables

- Vendor master; payment terms; tax profile.
- Vendor ledger; ageing; statements.
- Payment allocation, advances, debit notes.
- Supplier reconciliation.

### 4.6 Products and inventory

- Product master: classes, companies/brands, packs, units and conversions, barcodes, tax category, reorder levels.
- Warehouses / locations / bins.
- **Batches and expiry**, with **FEFO** consumption.
- Stock movements: in, out, transfer, adjustment, write-off, opening.
- Physical count with variance approval and posting.
- **Weighted-average valuation**, stock ledger, valuation report.
- Reorder and expiry alerting.

### 4.7 Procurement

```
Demand → Purchase Order → GRN → Supplier Invoice → Payment
                           ↓          ↓              ↓
                       Inventory   Payable          GL
```

- Demand/indent, approval workflow.
- Purchase order with pricing, tax, terms, partial receipt.
- GRN with batch, expiry, quantity variance handling.
- Supplier invoice matching (PO ↔ GRN ↔ invoice, 3-way).
- Purchase returns, debit notes, landed cost.
- Purchase register and analytics.

### 4.8 Sales

```
Quotation → Sale Order → Delivery → Invoice → Receipt
                            ↓          ↓         ↓
                        Inventory     GL    Customer Ledger
                        (+ COGS)
```

- Quotation, sale order, delivery challan, invoice.
- Pricing: price lists, customer-specific pricing, discount rules, discount override permission.
- Sales returns and credit notes.
- POS-style counter sale for cash businesses.
- Sales register, analytics, salesperson performance.

### 4.9 Tax and compliance *(Pakistan)*

Kept behind adapters and configuration so regulation can change without touching Sales:

- Sales tax / GST, further tax, extra tax.
- Withholding tax on purchases and payments.
- NTN/STRN capture and validation.
- FBR POS invoice integration (where applicable).
- Statutory report exports.
- Zakat deduction handling.
- Controlled-substance register where the product catalogue requires it.

### 4.10 Reporting

- **Financial:** trial balance, P&L, balance sheet, cash flow, account ledger, journal register.
- **Receivables/payables:** ageing, statements, collection forecast.
- **Inventory:** stock summary, stock ledger, valuation, expiry, slow-moving, reorder.
- **Sales/purchase:** registers, by-customer, by-product, by-territory, by-salesperson, margin analysis.
- **Compliance:** tax registers, audit extract.
- Export: PDF, Excel, CSV — every export audited.

### 4.11 HR *(minimal in v1)*

Employee master, attendance capture, payroll posting to GL. Deliberately shallow — full HR is out of scope for v1.

---

## 5. Non-functional requirements

| Area | Requirement |
|------|-------------|
| Correctness | FinancialInvariantSuite green on every PR; golden scenarios never drift |
| Security | OWASP ASVS as verification baseline; NIST SSDF as the SDLC baseline |
| Tenancy | Proven isolation at API and database layers, tested adversarially |
| Availability | Business-hours critical; planned maintenance windows acceptable in v1 |
| Performance | List APIs P95 < 500 ms; posting P95 < 800 ms; trial balance < 3 s |
| Recoverability | Restore drills pass; RPO ≤ 15 min, RTO ≤ 4 h |
| Auditability | Every financial mutation reconstructable from the audit log |
| Usability | Keyboard-first data entry; barcode-first in the store |
| Localisation | English UI v1; PKR base currency; Pakistani date and number conventions |
| Accessibility | Keyboard navigable, sufficient contrast, labelled controls |
| Browser | Current Chrome/Edge/Firefox; tablet-usable for store operations |

---

## 6. MVP — the first vertical slice

Before building the full module list, the factory must prove itself end-to-end on this path:

```
Organization → User → Chart of Accounts → Customer
   → Sale → Payment → Journal
   → Customer Ledger → General Ledger → Trial Balance → P&L
```

...with tenant isolation, RBAC and audit present at every step.

**MVP is accepted when:** a user in tenant A can create a customer, post a sale, receive a payment, and see the result correctly in the customer ledger, the general ledger, the trial balance and the P&L — while a user in tenant B can see none of it, every step is in the audit log, and the FinancialInvariantSuite is green.

If the factory can build that pipeline correctly and repeatably, scaling to the other modules is a matter of volume. If it cannot, nothing else should be started.

---

## 7. Release scope by wave

Delivery is incremental. We do not wait for all 100+ screens.

| Wave | Outcome |
|------|---------|
| 0 | Factory foundation — repo, CI, standards, test framework, design system |
| 1 | Platform — tenants, auth, RBAC, audit |
| 2 | **Accounting core — COA, JV, GL, trial balance, periods, reversal** |
| 3 | Cash and banking — cash book, bank book, cheque lifecycle |
| 4 | Customers and vendors — subledgers, AR/AP, allocation, statements |
| 5 | Products and inventory — movements, batches, FEFO, valuation |
| 6 | Procurement — demand, PO, GRN, supplier invoice, returns |
| 7 | Sales — quotation, order, delivery, invoice, return, COGS |
| 8 | Reporting — financial and operational |
| 9 | Compliance — tax, FBR, statutory |
| 10 | Migration — legacy import and reconciliation |
| Pilot | Bhatti Traders runs real operations |

Sequencing rationale and task decomposition: [IMPLEMENTATION.md](IMPLEMENTATION.md).

---

## 8. Migration requirements

Legacy migration is complete only when the numbers agree.

```
Extract → Normalize → Validate → Import → Reconcile
```

Acceptance gates:

```
Legacy trial balance      = New trial balance
Legacy customer balances  = New customer balances
Legacy vendor balances    = New vendor balances
Legacy stock quantities   = New stock quantities
Legacy stock valuation    = New stock valuation  (or variance explained in writing)
```

Every unmatched record is listed in a reconciliation report with a reason. "Close enough" is not an acceptance criterion. Migration runs as opening balances through the normal posting engine — never as direct inserts into the journal.

---

## 9. Explicitly out of scope for v1

Named here so no agent builds them speculatively:

- Microservice decomposition of the core domains
- Manufacturing / BOM / production planning
- Multi-currency transacting *(schema is currency-aware; only PKR is transacted in v1)*
- Full HR, payroll rules engine, leave management
- Mobile native applications
- Customer-facing portal
- Offline-first client
- E-commerce storefront integration
- Advanced BI / data warehouse / OLAP cubes
- Any AI feature that writes to the ledger *(see NON_NEGOTIABLES rule 22)*

An AI **assistant** that reads and suggests — "this looks like an office expense", "these three invoices are likely duplicates" — is in scope as a later enhancement, strictly as a suggestion surface behind normal authorization.

---

## 10. Success criteria

FinSoft v1 is successful when Bhatti Traders can:

1. Close a month without reconstructing numbers by hand.
2. Produce a trial balance, P&L and balance sheet that tie to the subledgers with no manual adjustment.
3. Trace any figure on any report to the source document and the user who entered it.
4. Take a stock count and post the variance with a correct valuation impact.
5. Run a day of real sales, receipts and cheques without a workaround.
6. Pass an audit request with exported evidence from the system alone.
7. Restore from backup in a drill within the RTO.

And when a **second tenant can be onboarded with configuration only.**

---

## 11. Related documents

- [NON_NEGOTIABLES.md](NON_NEGOTIABLES.md) — LEVEL 0
- [ARCHITECTURE.md](ARCHITECTURE.md) — LEVEL 1
- [IMPLEMENTATION.md](IMPLEMENTATION.md) — waves, contracts, gates
- [../AGENTS.md](../AGENTS.md) — agent operating rules
