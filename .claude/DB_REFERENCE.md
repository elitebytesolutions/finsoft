# DB_REFERENCE.md — Database Reference (source material)

> **Status: reference material, not authority.** This is captured design input from the
> legacy-system analysis session (Bhatti Traders — Oracle Forms pharmacy distribution).
> It records a proposed physical schema, engine decisions, formats and the keep/fix
> lessons drawn from the legacy database.
>
> It sits **below** every document in the authority table of
> [CLAUDE.md](../CLAUDE.md): where this file and
> [docs/NON_NEGOTIABLES.md](../docs/NON_NEGOTIABLES.md), [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)
> or an [ADR](../docs/adr/) disagree, **the FinSoft documents win** and this file is wrong.
> Nothing here is an approved migration. Ship no DDL from this file without the
> `database-guardian` and, for anything that posts, the `accounting-guardian`.

## Known gaps against the FinSoft constitution

Read these before copying any table below into a migration:

| This document | FinSoft rule it does not yet satisfy |
|---|---|
| No `tenant_id` on any table; single-org `organizations` row | Every tenant-owned row carries `tenant_id`, enforced to PostgreSQL RLS (ADR-0003, ADR-0004) |
| `is_posted` / `posted_at` flags updated in place on documents | Posted records are immutable; correct by reversal + re-entry (ADR-0006) |
| `DECIMAL`/`NUMERIC` mixed precisions per table | Money representation is fixed by ADR-0011 |
| Modules write `stock_movements` and journal rows directly | Modules raise events; only the kernels write the ledgers (ADR-0005, ADR-0008) |
| `avcost` stored on `products` | Weighted-average costing rules live in ADR-0007 |
| `v_current_stock` computed `stock_value` as `SUM(qty_in - qty_out) * avcost` | **The recomputation ADR-0015 §7 forbids.** Inventory value is the sum of signed stored value movements; average cost is a separate rate. Replaced in place by `v_stock_balances` / `v_available_stock` / `v_negative_stock` |
| Stock views filtered with `HAVING SUM(...) > 0` | Correct for a **picker**, wrong for an **authoritative** view. A balance view that hides negatives makes a negative-stock exception report permanently empty (ADR-0017) |
| `CHECK (discount_amount <= quantity * rate * discount_limit_pct / 100)` | A CHECK passes when its expression is NULL, and those columns are nullable — so it admitted any discount, including one that drives `cost_per_unit` negative |
| `cost_per_unit` divides by `total_qty`, which is NULL when `loose_per_pack = 0` | Prove the received quantity positive before dividing |
| No availability enforcement on posting | Stock sufficiency is checked **inside the posting transaction, under the ADR-0016 locks** — a pre-save check lets two sales each sell 8 of the same 10 units (ADR-0017) |
| Legacy `status VARCHAR(1)` enums, `MUSER`/`MTIME` lineage | Append-only audit record per financial mutation |
| Oracle-flavoured tablespaces (`APP_DATA`, `APP_INDEX`) | See [docs/INFRASTRUCTURE.md](../docs/INFRASTRUCTURE.md) for the real storage/role model |

**Provenance note:** the source transcript was interrupted several times by connection
drops, so a few passes end mid-table. Sections below marked *(from an earlier pass)* fill
those gaps from a different rendition of the same spec; column sets between passes are not
always identical.

---

## Part 0 — Lessons from the legacy system

### Keep (proven logic worth carrying forward)

- Stock derived live from the movement ledger (never cached)
- Batch + expiry + place FEFO inventory
- Weighted-average costing (AVCOST)
- Double-entry general ledger
- Draft → post two-phase model (with auto-post default)
- Audit trail (MUSER/MTIME → upgrade to full audit log)
- Narcotic flag on product + every transaction line
- Statutory sequential numbering (but auto-generated)
- Multi-level discount engine (global → product → batch → customer → line)
- Salesman & doctor commission tracking
- Reorder-driven procurement (RE_ORDER_LEVEL → demand → PO)
- Cheque lifecycle (issue/receive/clear/dishonour)
- Opening-balance JV rule (assets debit, liabilities credit, diff → capital)
- Pakistan compliance (GST, FBR/POS, NTN, Zakat)

### Fix (legacy anti-patterns not to repeat)

- Parallel table sets → one table with type discriminator
- No FKs → FKs on every transaction line
- MAX+1 numbering → database sequences/identity
- No triggers/validation → CHECK constraints + thin trigger layer
- Tables in SYSTEM → dedicated tablespaces
- Coarse grants → least-privilege RBAC roles
- DATASECURE → FISCAL_PERIODS with open/close
- STATEMENT1-8 staging tables → views/reports
- Manual invoice entry → auto-generated
- MUSER/MTIME → append-only audit log
- No partitioning → range-partition by period
- Opaque compiled Forms → versioned, testable application code

---

## Part 1 — Database engine decisions

### Engine selection

| Decision | Choice | Rationale |
|---|---|---|
| Database engine | PostgreSQL 15+ (or Oracle 19c+) | FKs, sequences/identity, CHECK constraints, partitioning, proper tablespaces |
| Character encoding | UTF-8 | Multi-language support (Urdu/English) |
| Collation | en_US.UTF-8 | Case-sensitive sorting for codes |
| Timezone | Store as UTC, display in Asia/Karachi (PKT) | Audit consistency |
| Connection pooling | PgBouncer / connection pool | High concurrency without exhausting connections |

### Tablespace strategy (non-negotiable)

NEVER use the system catalog tablespace for application data.

```text
Tablespaces:
  APP_DATA    <- all application tables (data)
  APP_INDEX   <- all indexes
  APP_TEMP    <- temporary tables, staging
  APP_ARCHIVE <- archived/cold partitions (year-end roll)

Schemas:
  public      <- all application tables
  audit       <- append-only audit log (separate schema, restricted access)
  archive     <- archived data (read-only after year-end roll)
```

### Naming conventions

| Object type | Convention | Example |
|---|---|---|
| Tables | snake_case, plural | sales, sale_lines, stock_movements |
| Columns | snake_case | sale_date, batch_no, qty_in |
| Primary keys | id (UUID or BIGSERIAL) + natural key UK | id, invoice_no |
| Foreign keys | <table_singular>_id | product_id, customer_id |
| Join tables | <table_a>_<table_b> | vendor_products |
| Indexes | idx_<table>_<columns> | idx_sales_customer_date |
| Unique constraints | uq_<table>_<columns> | uq_sales_invoice_no_book |
| Check constraints | ck_<table>_<rule> | ck_journal_lines_debit_or_credit |
| Foreign key constraints | fk_<table>_<column> | fk_sale_lines_product_id |
| Views | v_<name> | v_current_stock, v_trial_balance |
| Sequences | seq_<document_type> | seq_invoice_no, seq_po_no |
| Functions | fn_<name> | fn_amount_to_words, fn_calculate_avcost |
| Triggers | trg_<table>_<event> | trg_audit_log_insert |

### Data Type standards

| Data type | Used for | Never use |
|---|---|---|
| UUID (or BIGSERIAL) | Surrogate primary keys (id) | VARCHAR for IDs |
| VARCHAR(n) | Codes, names, short text | VARCHAR without length limit for keyed fields |
| TEXT | Long text, remarks, comments | VARCHAR(4000) |
| NUMERIC(15,2) | All monetary amounts (rupees) | FLOAT, REAL, DOUBLE |
| NUMERIC(10,3) | Quantities (3 decimal places for loose units) | INTEGER for quantities |
| NUMERIC(5,2) | Percentages (rates, discounts, tax) | INTEGER for percentages |
| DATE | Dates only (no time) | VARCHAR for dates |
| TIMESTAMPTZ | Timestamps (with timezone) | DATE for timestamps |
| BOOLEAN | Yes/No flags | VARCHAR(1) with 'Y'/'N' |
| JSONB | Flexible config, FBR response payloads | TEXT for structured data |
| BYTEA | Signatures, photos (delivery proof) | — |

### Partitioning strategy

| Table | Partition method | Key | Why |
|---|---|---|---|
| stock_movements | Range by month | movement_date | Grows indefinitely; archive old partitions |
| journal_lines | Range by month | entry_date | GL grows forever; period-based queries |
| audit_log | Range by month | created_at | Append-only; archival needed |

```sql
CREATE TABLE stock_movements (
    ...
  ) PARTITION BY RANGE (movement_date);

  CREATE TABLE stock_movements_2025_01 PARTITION OF stock_movements
    FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');
```

---

## Part 2 — Structural decisions

### 1. Primary keys

| Rule | Implementation |
|---|---|
| Every table has a PK | id BIGSERIAL (auto-increment identity) |
| PK is surrogate | Never use natural keys (names, codes) as PK — they change |
| Natural keys get UNIQUE constraint | e.g., product_code, invoice_number, account_code |

### 2. Foreign keys — every transaction line to a master

```sql
-- NON-NEGOTIABLE: every transaction line MUST have FK to its master
  ALTER TABLE sale_lines ADD CONSTRAINT fk_sale_line_sale
    FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE RESTRICT;

  ALTER TABLE sale_lines ADD CONSTRAINT fk_sale_line_product
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT;

  ALTER TABLE sale_lines ADD CONSTRAINT fk_sale_line_batch
    FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE RESTRICT;
```

| Link | FK | Status |
|---|---|---|
| Sale line → Sale master | sale_lines.sale_id → sales.id | Mandatory |
| Sale line → Product | sale_lines.product_id → products.id | Mandatory |
| Sale line → Batch | sale_lines.batch_id → batches.id | Mandatory |
| Purchase line → Purchase master | grn_lines.grn_id → grn_headers.id | Mandatory |
| Purchase line → Product | grn_lines.product_id → products.id | Mandatory |
| Stock movement → Product | stock_movements.product_id → products.id | Mandatory |
| Stock movement → Batch | stock_movements.batch_id → batches.id | Mandatory |
| Journal line → Journal entry | journal_lines.journal_entry_id → journal_entries.id | Mandatory |
| Journal line → Account (COA) | journal_lines.account_id → accounts.id | Mandatory |
| Cash/Bank voucher → Party | cash_vouchers.party_id → parties.id | Mandatory |
| DC line → DC master | dc_lines.dc_id → delivery_challans.id | Mandatory |
| DC line → Sale | delivery_challans.sale_id → sales.id | Mandatory |

Bhatti Traders had only 13 FKs (3 disabled). Orphan rows were possible. This is non-negotiable in the new system.

### 3. Sequences / identity columns

```sql
-- Every document number uses a database sequence — NEVER MAX+1
  CREATE SEQUENCE sale_no_seq START 1;
  CREATE SEQUENCE purchase_no_seq START 1;
  CREATE SEQUENCE voucher_no_seq START 1;
  CREATE SEQUENCE po_no_seq START 1;
  CREATE SEQUENCE journal_no_seq START 1;
  CREATE SEQUENCE dc_no_seq START 1;
```

| Document | Sequence | Format | Example |
|---|---|---|---|
| Sale number | sale_no_seq | SALE-2025-000001 | Internal tracking |
| Invoice number | invoice_no_seq | INV-2025-000001 | Auto-generated, unique per book, FBR-compliant |
| Purchase/GRN number | purchase_no_seq | GRN-2025-000001 | Internal GRN tracking |
| PO number | po_no_seq | PO-2025-000001 | Sent to supplier |
| Cash voucher number | voucher_no_seq | CV-2025-000001 | Sequential, non-reusable |
| Journal voucher number | journal_no_seq | JV-2025-000001 | Sequential, non-reusable |
| DC number | dc_no_seq | DC-2025-000001 | Delivery challan |

Bhatti Traders used MAX+1 with zero sequences → duplicate invoice numbers (Bug #1). This is non-negotiable.

### 4. CHECK constraints

```sql
-- Sale quantity must be positive
  ALTER TABLE sale_lines ADD CONSTRAINT chk_sale_qty
    CHECK (quantity > 0);

  -- Stock movement: one of in/out must be zero
  ALTER TABLE stock_movements ADD CONSTRAINT chk_movement_qty
    CHECK ((qty_in >= 0 AND qty_out >= 0) AND (qty_in > 0 OR qty_out > 0));

  -- JV must balance per entry (enforced via trigger/constraint)
  ALTER TABLE journal_entries ADD CONSTRAINT chk_jv_balanced
    CHECK (total_debit = total_credit);

  -- ⚠ REJECTED — do not copy:
  --   CHECK (discount_amount <= (quantity * rate * discount_limit_pct / 100))
  -- A CHECK passes when its expression evaluates to NULL. If rate or
  -- discount_limit_pct is NULL the comparison is NULL and the constraint
  -- admits ANY discount — including one that exceeds the line and drives
  -- net_amount, and therefore cost_per_unit, negative. The columns are not
  -- declared NOT NULL, so this is reachable, not theoretical.
  ALTER TABLE sale_lines
    ALTER COLUMN quantity             SET NOT NULL,
    ALTER COLUMN rate                 SET NOT NULL,
    ALTER COLUMN discount_amount      SET NOT NULL,
    ALTER COLUMN discount_limit_pct   SET NOT NULL;

  ALTER TABLE sale_lines ADD CONSTRAINT chk_disc_nonneg
    CHECK (discount_amount >= 0 AND discount_limit_pct >= 0 AND rate >= 0);

  -- Discount may not exceed the DISCOUNTABLE amount. Stated as a product,
  -- not a division, so there is no rounding step and no zero denominator.
  ALTER TABLE sale_lines ADD CONSTRAINT chk_disc_limit
    CHECK (discount_amount * 100 <= quantity * rate * discount_limit_pct);

  -- Never divide by a received quantity without proving it positive first.
  -- grn_lines.total_qty is GENERATED with NULLIF(loose_per_pack, 0), so it
  -- is NULL when loose_per_pack = 0 — and cost_per_unit = net_amount /
  -- total_qty then yields NULL rather than an error.
  ALTER TABLE grn_lines ADD CONSTRAINT chk_grn_total_qty_positive
    CHECK (total_qty IS NOT NULL AND total_qty > 0);

  -- Cost per unit is never negative. This is the constraint that actually
  -- catches the discount-exceeds-amount case at the point it does damage.
  ALTER TABLE grn_lines ADD CONSTRAINT chk_grn_cost_nonneg
    CHECK (cost_per_unit >= 0 AND net_amount >= 0);

  -- Fiscal period must be open to post
  -- (Enforced via trigger — see triggers section)

  -- ⚠ Do NOT add nonnegative constraints to signed columns.
  -- inventory_value_delta, rounding_amount, negative_stock_variance and
  -- journal line amounts are SIGNED by design: outflows and reversals are
  -- legitimately negative (ADR-0015 §5, §8; ADR-0006). A blanket
  -- "amount >= 0" sweep across money columns would block every reversal in
  -- the system. Nonnegativity belongs on INPUT quantities, rates and
  -- discounts — not on ledger deltas.

  -- ⚠ Bonus quantity does NOT cause negative cost, and must not be
  -- constrained as though it did. cost_per_unit = net_amount / total_qty,
  -- and bonus_qty appears only in the DENOMINATOR (total_qty). Adding
  -- positive bonus can only reduce the magnitude of the rate; it cannot
  -- change its sign. The sign comes from net_amount, i.e. from discount
  -- exceeding the line — which chk_grn_cost_nonneg above now catches.
  -- An arbitrary `bonus_qty <= pack_qty * 2` rule was proposed and is
  -- REJECTED: it treats a symptom that does not exist, and it would reject
  -- legitimate supplier deals. Unusual bonus ratios are a configurable
  -- WARNING or approval threshold in the application, not a CHECK.

  -- Place code must be S or W
  ALTER TABLE stock_movements ADD CONSTRAINT chk_place
    CHECK (place_code IN ('S', 'W'));

  -- Sale type must be valid
  ALTER TABLE sales ADD CONSTRAINT chk_sale_type
    CHECK (sale_type IN ('retail', 'wholesale', 'hospital', 'lab', 'counter'));
```

### 5. Triggers (thin, audited layer only)

Only 4 triggers — minimal, audited, each serving a purpose nothing else can:

| Trigger | Table | Purpose |
|---|---|---|
| trg_stock_movement_audit | stock_movements | After insert: write to audit_log with before/after |
| trg_journal_balance_check | journal_lines | After insert/update: verify ΣDr = ΣCr per entry, reject if unbalanced |
| trg_avcost_reroll | stock_movements | After purchase movement insert: re-roll weighted-average cost |
| trg_period_lock | ALL transaction tables | Before insert/update: check fiscal period is open, reject if closed |

Bhatti Traders had 9 triggers (PARTY↔ACCOUNT sync, VENDOR↔ACCOUNT sync, distributor journal). The new system unifies parties into one table, eliminating the sync triggers entirely.

### 6. Indexes

```sql
-- Hot path: stock lookups (replaces the PROD_POST cluster)
  CREATE INDEX idx_stock_product ON stock_movements (product_id, batch_id, place_code);
  CREATE INDEX idx_stock_movement_date ON stock_movements (movement_date);

  -- Sale lookup
  CREATE INDEX idx_sale_customer ON sales (customer_id, sale_date);
  CREATE INDEX idx_sale_invoice ON sales (invoice_number);
  CREATE UNIQUE INDEX idx_sale_invoice_unique ON sales (invoice_number, invoice_book_id);

  -- GL lookup
  CREATE INDEX idx_gl_account_date ON journal_lines (account_id, entry_date);
  CREATE INDEX idx_gl_entry ON journal_lines (journal_entry_id);

  -- Audit
  CREATE INDEX idx_audit_entity ON audit_log (entity_type, entity_id, created_at);
```

---

## Part 3 — Complete table structures

### Masters

#### `organizations` — own company

```sql
CREATE TABLE organizations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(100) NOT NULL,
    ntn             VARCHAR(20),                    -- National Tax Number
    strn            VARCHAR(20),                    -- Sales Tax Registration Number
    address         TEXT,
    phone           VARCHAR(30),
    email           VARCHAR(60),
    bank_name       VARCHAR(40),
    bank_account    VARCHAR(30),
    logo            BYTEA,
    fiscal_year_start_month INTEGER NOT NULL DEFAULT 7,  -- July start (Pakistan)
    base_currency   VARCHAR(3) NOT NULL DEFAULT 'PKR',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
```

#### `parties` — unified customers + suppliers

```sql
CREATE TABLE parties (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code            VARCHAR(20) NOT NULL,           -- Human-readable code (e.g., CUST-001)
    name            VARCHAR(100) NOT NULL,
    party_type      VARCHAR(10) NOT NULL,           -- 'CUSTOMER', 'SUPPLIER', 'BOTH'
    account_id      UUID,                           -- FK to chart_of_accounts (ledger account)
    address         TEXT,
    city_id         UUID,
    area_id         UUID,
    phone           VARCHAR(30),
    mobile          VARCHAR(30),
    email           VARCHAR(60),
    fax             VARCHAR(20),
    ntn             VARCHAR(20),
    strn            VARCHAR(20),
    nic             VARCHAR(20),
    licence_no      VARCHAR(20),                    -- Drug licence (pharmacy)
    licence_expiry  DATE,
    credit_days     INTEGER NOT NULL DEFAULT 0,
    credit_limit    NUMERIC(15,2) NOT NULL DEFAULT 0,
    discount_limit  NUMERIC(5,2) NOT NULL DEFAULT 0, -- Max discount % allowed
    salesman_id     UUID,                           -- Assigned salesman
    delivery_person VARCHAR(60),
    vehicle_type    VARCHAR(20),
    -- Guarantor block (for credit customers)
    guarantor_name  VARCHAR(60),
    guarantor_father VARCHAR(60),
    guarantor_phone VARCHAR(30),
    guarantor_nic   VARCHAR(20),
    guarantor_address TEXT,
    status          VARCHAR(10) NOT NULL DEFAULT 'ACTIVE', -- 'ACTIVE', 'INACTIVE', 'BLOCKED'
    created_by      UUID NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_parties_code UNIQUE (code),
    CONSTRAINT uq_parties_name UNIQUE (name),       -- Prevents duplicate names (Bug #10)
    CONSTRAINT ck_parties_type CHECK (party_type IN ('CUSTOMER','SUPPLIER','BOTH')),
    CONSTRAINT ck_parties_status CHECK (status IN ('ACTIVE','INACTIVE','BLOCKED')),
    CONSTRAINT fk_parties_city FOREIGN KEY (city_id) REFERENCES cities(id),
    CONSTRAINT fk_parties_area FOREIGN KEY (area_id) REFERENCES areas(id),
    CONSTRAINT fk_parties_account FOREIGN KEY (account_id) REFERENCES chart_of_accounts(id),
    CONSTRAINT fk_parties_salesman FOREIGN KEY (salesman_id) REFERENCES salesmen(id),
    CONSTRAINT fk_parties_created_by FOREIGN KEY (created_by) REFERENCES users(id)
  );
```

#### `companies` — manufacturers

```sql
CREATE TABLE companies (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code            VARCHAR(20) NOT NULL,
    name            VARCHAR(60) NOT NULL,
    address         VARCHAR(100),
    city            VARCHAR(25),
    phone           VARCHAR(20),
    fax             VARCHAR(20),
    email           VARCHAR(30),
    vendor_flag     BOOLEAN NOT NULL DEFAULT FALSE,  -- Is this also a vendor?
    status          VARCHAR(10) NOT NULL DEFAULT 'ACTIVE',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_companies_code UNIQUE (code),
    CONSTRAINT uq_companies_name UNIQUE (name)
  );
```

#### `vendors` — suppliers

```sql
CREATE TABLE vendors (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code            VARCHAR(20) NOT NULL,
    name            VARCHAR(60) NOT NULL,
    party_id        UUID NOT NULL,                   -- FK to parties (unified)
    address         VARCHAR(100),
    city            VARCHAR(25),
    phone           VARCHAR(20),
    mobile          VARCHAR(20),
    email           VARCHAR(30),
    credit_days     INTEGER NOT NULL DEFAULT 0,
    level           INTEGER,                         -- Vendor tier
    status          VARCHAR(10) NOT NULL DEFAULT 'ACTIVE',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_vendors_code UNIQUE (code),
    CONSTRAINT uq_vendors_name UNIQUE (name),
    CONSTRAINT fk_vendors_party FOREIGN KEY (party_id) REFERENCES parties(id)
  );
```

#### `vendor_products` — FIXES the design gap — maps vendors to products

```sql
CREATE TABLE vendor_products (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vendor_id       UUID NOT NULL,
    product_id      UUID NOT NULL,
    last_rate       NUMERIC(15,2),                   -- Last purchase rate from this vendor
    last_purchased  DATE,
    is_preferred    BOOLEAN NOT NULL DEFAULT FALSE,  -- Primary vendor for this product
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_vendor_products UNIQUE (vendor_id, product_id),
    CONSTRAINT fk_vp_vendor FOREIGN KEY (vendor_id) REFERENCES vendors(id),
    CONSTRAINT fk_vp_product FOREIGN KEY (product_id) REFERENCES products(id)
  );
```

#### `cities / areas`

```sql
CREATE TABLE cities (
    id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code    VARCHAR(10) NOT NULL,
    name    VARCHAR(30) NOT NULL,
    CONSTRAINT uq_cities_code UNIQUE (code),
    CONSTRAINT uq_cities_name UNIQUE (name)
  );

  CREATE TABLE areas (
    id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code    VARCHAR(10) NOT NULL,
    name    VARCHAR(30) NOT NULL,
    city_id UUID,
    CONSTRAINT uq_areas_code UNIQUE (code),
    CONSTRAINT fk_areas_city FOREIGN KEY (city_id) REFERENCES cities(id)
  );
```

#### `salesmen`

```sql
CREATE TABLE salesmen (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code            VARCHAR(10) NOT NULL,           -- e.g., S001
    name            VARCHAR(60) NOT NULL,
    commission_rate NUMERIC(5,2) NOT NULL DEFAULT 0, -- Commission %
    duty_hours      INTEGER NOT NULL DEFAULT 8,
    salary          NUMERIC(15,2) NOT NULL DEFAULT 0,
    allowance       NUMERIC(15,2) NOT NULL DEFAULT 0,
    territory_id    UUID,                            -- Assigned territory
    status          VARCHAR(10) NOT NULL DEFAULT 'ACTIVE',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_salesmen_code UNIQUE (code),
    CONSTRAINT uq_salesmen_name UNIQUE (name)
  );
```

#### `doctors`

```sql
CREATE TABLE doctors (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code            VARCHAR(10) NOT NULL,
    name            VARCHAR(60) NOT NULL,
    address         VARCHAR(100),
    city            VARCHAR(25),
    phone           VARCHAR(20),
    mobile          VARCHAR(20),
    commission_pct  NUMERIC(5,2) NOT NULL DEFAULT 0, -- Commission % on referred sales
    room            VARCHAR(10),
    status          VARCHAR(10) NOT NULL DEFAULT 'ACTIVE',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_doctors_code UNIQUE (code),
    CONSTRAINT uq_doctors_name UNIQUE (name)
  );
```

#### `users`

```sql
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username        VARCHAR(30) NOT NULL,
    email           VARCHAR(60),
    password_hash   VARCHAR(255) NOT NULL,           -- bcrypt/argon2 hashed
    full_name       VARCHAR(60) NOT NULL,
    role_id         UUID NOT NULL,
    salesman_id     UUID,                            -- If user is a salesman
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    last_login      TIMESTAMPTZ,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_users_username UNIQUE (username),
    CONSTRAINT uq_users_email UNIQUE (email),
    CONSTRAINT fk_users_role FOREIGN KEY (role_id) REFERENCES roles(id),
    CONSTRAINT fk_users_salesman FOREIGN KEY (salesman_id) REFERENCES salesmen(id)
  );
```

#### `roles`

```sql
CREATE TABLE roles (
    id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name    VARCHAR(30) NOT NULL,                    -- admin, accountant, cashier, etc.
    description TEXT,
    CONSTRAINT uq_roles_name UNIQUE (name)
  );

  -- Role permission matrix
  CREATE TABLE role_permissions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    role_id     UUID NOT NULL,
    module      VARCHAR(30) NOT NULL,                -- sales, inventory, finance, etc.
    can_create  BOOLEAN NOT NULL DEFAULT FALSE,
    can_read    BOOLEAN NOT NULL DEFAULT FALSE,
    can_update  BOOLEAN NOT NULL DEFAULT FALSE,
    can_delete  BOOLEAN NOT NULL DEFAULT FALSE,      -- Only admin gets TRUE
    can_post    BOOLEAN NOT NULL DEFAULT FALSE,      -- Post to GL/stock
    can_approve BOOLEAN NOT NULL DEFAULT FALSE,      -- Approve drafts/overrides

    CONSTRAINT uq_role_permissions UNIQUE (role_id, module),
    CONSTRAINT fk_rp_role FOREIGN KEY (role_id) REFERENCES roles(id)
  );
```

### Product & catalog

#### `products`

```sql
CREATE TABLE products (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code                VARCHAR(10) NOT NULL,         -- PR_NO equivalent
    name                VARCHAR(100) NOT NULL,        -- PR_NAME
    generic_name        VARCHAR(100),                 -- Generic drug name
    contents            VARCHAR(100),                 -- Drug contents
    packing             VARCHAR(20),                  -- Pack size (e.g., "10s", "1btl")
    loose_per_pack      INTEGER NOT NULL DEFAULT 1,   -- Loose units per pack (conversion)
    company_id          UUID,                         -- FK to companies (manufacturer)
    product_class_id    UUID,                         -- FK to product_classes
    barcode             VARCHAR(30),                  -- Primary barcode
    purchase_rate       NUMERIC(15,2) NOT NULL DEFAULT 0,
    sale_rate           NUMERIC(15,2) NOT NULL DEFAULT 0,
    wholesale_rate      NUMERIC(15,2) NOT NULL DEFAULT 0,
    gst_rate            NUMERIC(5,2) NOT NULL DEFAULT 0,  -- GST %
    shelf_location      VARCHAR(10),
    reorder_level       INTEGER NOT NULL DEFAULT 0,
    high_level          INTEGER NOT NULL DEFAULT 0,
    avcost              NUMERIC(15,2) NOT NULL DEFAULT 0,  -- Weighted-average cost
    is_narcotic         BOOLEAN NOT NULL DEFAULT FALSE,    -- Controlled substance
    is_precious         BOOLEAN NOT NULL DEFAULT FALSE,    -- High-value flag
    is_short_expiry     BOOLEAN NOT NULL DEFAULT FALSE,    -- Short-expiry sensitive
    requires_expiry     BOOLEAN NOT NULL DEFAULT TRUE,     -- Needs batch/expiry tracking
    disc_tier_1         NUMERIC(5,2) NOT NULL DEFAULT 0,   -- Discount tier 1 %
    disc_tier_2         NUMERIC(5,2) NOT NULL DEFAULT 0,   -- Discount tier 2 %
    batch_disc_pct      NUMERIC(5,2) NOT NULL DEFAULT 0,   -- Batch discount %
    status              VARCHAR(10) NOT NULL DEFAULT 'ACTIVE',
    created_by          UUID NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_products_code UNIQUE (code),
    CONSTRAINT uq_products_name UNIQUE (name),
    CONSTRAINT uq_products_barcode UNIQUE (barcode),
    CONSTRAINT ck_products_status CHECK (status IN ('ACTIVE','INACTIVE','DISCONTINUED')),
    CONSTRAINT fk_products_company FOREIGN KEY (company_id) REFERENCES companies(id),
    CONSTRAINT fk_products_class FOREIGN KEY (product_class_id) REFERENCES product_classes(id),
    CONSTRAINT fk_products_created_by FOREIGN KEY (created_by) REFERENCES users(id)
  );
```

#### `product_classes`

```sql
CREATE TABLE product_classes (
    id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code    INTEGER NOT NULL,
    name    VARCHAR(30) NOT NULL,
    CONSTRAINT uq_classes_code UNIQUE (code),
    CONSTRAINT uq_classes_name UNIQUE (name)
  );
```

#### `generic_drugs`

```sql
CREATE TABLE generic_drugs (
    id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name    VARCHAR(100) NOT NULL,
    CONSTRAINT uq_generic_name UNIQUE (name)
  );
```

#### `batches` — batch master — FIXES the batch/expiry tracking

```sql
CREATE TABLE batches (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id      UUID NOT NULL,
    batch_no        VARCHAR(20) NOT NULL,
    expiry_date     DATE NOT NULL,
    mfg_date        DATE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_batches UNIQUE (product_id, batch_no),  -- One batch per product
    CONSTRAINT fk_batches_product FOREIGN KEY (product_id) REFERENCES products(id)
  );
```

#### `places` — stock locations

```sql
CREATE TABLE places (
    id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code    VARCHAR(10) NOT NULL,                    -- 'S' shop, 'W' warehouse
    name    VARCHAR(30) NOT NULL,
    type    VARCHAR(10) NOT NULL,                    -- 'SHOP', 'WAREHOUSE', 'COUNTER'
    CONSTRAINT uq_places_code UNIQUE (code)
  );
```

### Inventory — stock movement ledger

#### `stock_movements` — the core — replaces CL_DPOST

```sql
CREATE TABLE stock_movements (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    movement_no     BIGSERIAL,                       -- Sequential movement number
    movement_date   DATE NOT NULL,
    movement_time   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    product_id      UUID NOT NULL,
    batch_no        VARCHAR(20),                     -- Batch (nullable for non-medical)
    expiry_date     DATE,                            -- Expiry (nullable for non-medical)
    place_id        UUID NOT NULL,                   -- Where stock sits
    qty_in          NUMERIC(10,3) NOT NULL DEFAULT 0, -- Received
    qty_out         NUMERIC(10,3) NOT NULL DEFAULT 0, -- Issued
    cost_per_unit   NUMERIC(15,2) NOT NULL DEFAULT 0, -- Cost at time of movement
    sale_rate       NUMERIC(15,2),                   -- Sale rate at time of movement
    movement_type   VARCHAR(20) NOT NULL,            -- See CHECK below
    ref_type        VARCHAR(20),                     -- 'SALE', 'PURCHASE', 'RETURN', etc.
    ref_id          UUID,                            -- FK to the source transaction
    ref_no          VARCHAR(30),                     -- Human-readable reference (invoice no, etc.)
    party_id        UUID,                            -- Customer/supplier
    salesman_id     UUID,
    is_narcotic     BOOLEAN NOT NULL DEFAULT FALSE,  -- Narcotic flag carried
    remarks         TEXT,
    created_by      UUID NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT ck_sm_type CHECK (movement_type IN (
        'PURCHASE', 'SALE', 'SALE_RETURN', 'PURCHASE_RETURN',
        'BREAKAGE', 'GIFT', 'SHIFT_IN', 'SHIFT_OUT',
        'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'OPENING', 'ISSUE'
    )),
    CONSTRAINT ck_sm_qty CHECK (
        (qty_in > 0 AND qty_out = 0) OR
        (qty_out > 0 AND qty_in = 0) OR
        (qty_in = 0 AND qty_out = 0)  -- zero-qty adjustment record
    ),
    CONSTRAINT fk_sm_product FOREIGN KEY (product_id) REFERENCES products(id),
    CONSTRAINT fk_sm_place FOREIGN KEY (place_id) REFERENCES places(id),
    CONSTRAINT fk_sm_party FOREIGN KEY (party_id) REFERENCES parties(id),
    CONSTRAINT fk_sm_salesman FOREIGN KEY (salesman_id) REFERENCES salesmen(id),
    CONSTRAINT fk_sm_created_by FOREIGN KEY (created_by) REFERENCES users(id)
  );

  CREATE INDEX idx_sm_product_batch_place ON stock_movements(product_id, batch_no, place_id);
  CREATE INDEX idx_sm_date ON stock_movements(movement_date);
  CREATE INDEX idx_sm_ref ON stock_movements(ref_type, ref_id);
```

NON-NEGOTIABLE RULE: Stock is NEVER stored as a column. It is ALWAYS derived:

```sql
CREATE OR REPLACE VIEW v_current_stock AS
  SELECT
    p.id AS product_id,
    p.code AS product_code,
    p.name AS product_name,
    p.packing,
    p.company_id,
    p.avcost,
    p.reorder_level,
    p.high_level,
    p.is_narcotic,
    COALESCE(SUM(sm.qty_in - sm.qty_out), 0) AS current_stock
  FROM products p
  LEFT JOIN stock_movements sm ON p.id = sm.product_id
  GROUP BY p.id, p.code, p.name, p.packing, p.company_id, p.avcost,
         p.reorder_level, p.high_level, p.is_narcotic;

  -- Batch + place + expiry aware (for FEFO picking)
  CREATE OR REPLACE VIEW v_batch_stock AS
  SELECT
    sm.product_id,
    p.name AS product_name,
    sm.batch_no,
    sm.expiry_date,
    sm.place_id,
    pl.name AS place_name,
    SUM(sm.qty_in - sm.qty_out) AS available_qty,
    p.avcost,
    p.sale_rate
  FROM stock_movements sm
  JOIN products p ON sm.product_id = p.id
  JOIN places pl ON sm.place_id = pl.id
  GROUP BY sm.product_id, p.name, sm.batch_no, sm.expiry_date, sm.place_id, pl.name, p.avcost, p.sale_rate
  HAVING SUM(sm.qty_in - sm.qty_out) > 0
  ORDER BY sm.expiry_date;  -- FEFO: earliest expiry first
```

#### `stock_adjustments`

```sql
CREATE TABLE stock_adjustments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    adjustment_no   VARCHAR(20) NOT NULL,
    adjustment_date DATE NOT NULL,
    place_id        UUID NOT NULL,
    adjustment_type VARCHAR(10) NOT NULL,            -- 'GAIN' or 'LOSS'
    reason          TEXT NOT NULL,
    approved_by     UUID,
    approved_at     TIMESTAMPTZ,
    status          VARCHAR(10) NOT NULL DEFAULT 'PENDING', -- 'PENDING', 'APPROVED', 'REJECTED'
    created_by      UUID NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_adj_no UNIQUE (adjustment_no),
    CONSTRAINT ck_adj_type CHECK (adjustment_type IN ('GAIN','LOSS')),
    CONSTRAINT fk_adj_place FOREIGN KEY (place_id) REFERENCES places(id),
    CONSTRAINT fk_adj_approved FOREIGN KEY (approved_by) REFERENCES users(id)
  );
```

### Procurement

#### `purchase_orders`

```sql
CREATE TABLE purchase_orders (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    po_no           VARCHAR(20) NOT NULL,            -- Sequential PO number (from seq_po_no)
    po_date         DATE NOT NULL,
    vendor_id       UUID NOT NULL,
    party_id        UUID NOT NULL,                    -- Supplier party
    expected_date   DATE,                             -- Expected delivery
    total_amount    NUMERIC(15,2) NOT NULL DEFAULT 0,
    status          VARCHAR(15) NOT NULL DEFAULT 'DRAFT', -- 'DRAFT','SENT','PARTIAL','RECEIVED','CLOSED','CANCELLED'
    remarks         TEXT,
    created_by      UUID NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_po_no UNIQUE (po_no),
    CONSTRAINT ck_po_status CHECK (status IN ('DRAFT','SENT','PARTIAL','RECEIVED','CLOSED','CANCELLED')),
    CONSTRAINT fk_po_vendor FOREIGN KEY (vendor_id) REFERENCES vendors(id),
    CONSTRAINT fk_po_party FOREIGN KEY (party_id) REFERENCES parties(id),
    CONSTRAINT fk_po_created_by FOREIGN KEY (created_by) REFERENCES users(id)
  );
```

#### `purchase_order_lines`

```sql
CREATE TABLE purchase_order_lines (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    po_id           UUID NOT NULL,
    product_id      UUID NOT NULL,
    quantity        NUMERIC(10,3) NOT NULL,
    rate            NUMERIC(15,2) NOT NULL,
    amount          NUMERIC(15,2) GENERATED ALWAYS AS (quantity * rate) STORED,
    received_qty    NUMERIC(10,3) NOT NULL DEFAULT 0,  -- Tracks receipt against PO

    CONSTRAINT fk_pol_po FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON DELETE CASCADE,
    CONSTRAINT fk_pol_product FOREIGN KEY (product_id) REFERENCES products(id)
  );
```

#### `grn_headers` — purchase voucher / goods receipt note

```sql
CREATE TABLE grn_headers (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    grn_no              VARCHAR(20) NOT NULL,         -- Sequential GRN number (from seq_grn_no)
    grn_date            DATE NOT NULL,
    grn_time            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    po_id               UUID,                         -- FK to purchase_orders (optional)
    vendor_id           UUID NOT NULL,
    party_id            UUID NOT NULL,
    supplier_bill_no    VARCHAR(30),                  -- Supplier's invoice number
    supplier_bill_date  DATE,
    place_id            UUID NOT NULL,                -- Where goods received
    gross_amount        NUMERIC(15,2) NOT NULL DEFAULT 0,
    discount_amount     NUMERIC(15,2) NOT NULL DEFAULT 0,
    tax_amount          NUMERIC(15,2) NOT NULL DEFAULT 0,
    net_amount          NUMERIC(15,2) NOT NULL DEFAULT 0,
    amount_paid         NUMERIC(15,2) NOT NULL DEFAULT 0,
    balance_amount      NUMERIC(15,2) NOT NULL DEFAULT 0,
    payment_mode        VARCHAR(10),                  -- 'CASH', 'CREDIT', 'BANK'
    due_date            DATE,                         -- If credit
    is_posted           BOOLEAN NOT NULL DEFAULT FALSE, -- Draft / Posted
    posted_at           TIMESTAMPTZ,
    posted_by           UUID,
    remarks             TEXT,
    created_by          UUID NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_grn_no UNIQUE (grn_no),
    CONSTRAINT ck_grn_payment CHECK (payment_mode IN ('CASH','CREDIT','BANK')),
    CONSTRAINT fk_grn_po FOREIGN KEY (po_id) REFERENCES purchase_orders(id),
    CONSTRAINT fk_grn_vendor FOREIGN KEY (vendor_id) REFERENCES vendors(id),
    CONSTRAINT fk_grn_party FOREIGN KEY (party_id) REFERENCES parties(id),
    CONSTRAINT fk_grn_place FOREIGN KEY (place_id) REFERENCES places(id),
    CONSTRAINT fk_grn_posted_by FOREIGN KEY (posted_by) REFERENCES users(id),
    CONSTRAINT fk_grn_created_by FOREIGN KEY (created_by) REFERENCES users(id)
  );
```

#### `grn_lines` — purchase lines

```sql
CREATE TABLE grn_lines (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    grn_id          UUID NOT NULL,
    product_id      UUID NOT NULL,
    batch_no        VARCHAR(20),                     -- Batch from supplier packaging
    expiry_date     DATE,                            -- Expiry from packaging
    pack_qty        NUMERIC(10,3) NOT NULL,          -- Full packs
    bonus_qty       NUMERIC(10,3) NOT NULL DEFAULT 0, -- Free packs
    loose_qty       NUMERIC(10,3) NOT NULL DEFAULT 0, -- Loose units
    total_qty       NUMERIC(10,3) GENERATED ALWAYS AS (pack_qty + bonus_qty + (loose_qty / NULLIF(loose_per_pack, 0))) STORED,
    rate            NUMERIC(15,2) NOT NULL,          -- Purchase rate per pack
    discount_pct    NUMERIC(5,2) NOT NULL DEFAULT 0,
    discount_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
    gst_pct         NUMERIC(5,2) NOT NULL DEFAULT 0,
    gst_amount      NUMERIC(15,2) NOT NULL DEFAULT 0,
    amount          NUMERIC(15,2) NOT NULL,          -- qty × rate
    net_amount      NUMERIC(15,2) NOT NULL,          -- After discount + tax
    cost_per_unit   NUMERIC(15,2) NOT NULL,          -- Net cost per unit (after bonus adj)
    is_narcotic     BOOLEAN NOT NULL DEFAULT FALSE,
    shelf_location  VARCHAR(10),
    place_id        UUID NOT NULL,
    created_by      UUID NOT NULL,

    CONSTRAINT fk_gl_grn FOREIGN KEY (grn_id) REFERENCES grn_headers(id) ON DELETE CASCADE,
    CONSTRAINT fk_gl_product FOREIGN KEY (product_id) REFERENCES products(id),
    CONSTRAINT fk_gl_place FOREIGN KEY (place_id) REFERENCES places(id),
    CONSTRAINT fk_gl_created_by FOREIGN KEY (created_by) REFERENCES users(id)
  );
```

#### `purchase_returns`

```sql
CREATE TABLE purchase_returns (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    return_no       VARCHAR(20) NOT NULL,
    return_date     DATE NOT NULL,
    grn_id          UUID NOT NULL,                   -- Original GRN being returned
    vendor_id       UUID NOT NULL,
    party_id        UUID NOT NULL,
    total_amount    NUMERIC(15,2) NOT NULL DEFAULT 0,
    reason          TEXT NOT NULL,
    is_posted       BOOLEAN NOT NULL DEFAULT FALSE,
    posted_at       TIMESTAMPTZ,
    posted_by       UUID,
    created_by      UUID NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_preturn_no UNIQUE (return_no),
    CONSTRAINT fk_pr_grn FOREIGN KEY (grn_id) REFERENCES grn_headers(id),
    CONSTRAINT fk_pr_vendor FOREIGN KEY (vendor_id) REFERENCES vendors(id),
    CONSTRAINT fk_pr_party FOREIGN KEY (party_id) REFERENCES parties(id),
    CONSTRAINT fk_pr_posted_by FOREIGN KEY (posted_by) REFERENCES users(id),
    CONSTRAINT fk_pr_created_by FOREIGN KEY (created_by) REFERENCES users(id)
  );

  CREATE TABLE purchase_return_lines (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    return_id       UUID NOT NULL,
    product_id      UUID NOT NULL,
    batch_no        VARCHAR(20),
    expiry_date     DATE,
    quantity        NUMERIC(10,3) NOT NULL,
    rate            NUMERIC(15,2) NOT NULL,
    cost_per_unit   NUMERIC(15,2) NOT NULL,
    amount          NUMERIC(15,2) NOT NULL,

    CONSTRAINT fk_prl_return FOREIGN KEY (return_id) REFERENCES purchase_returns(id) ON DELETE CASCADE,
    CONSTRAINT fk_prl_product FOREIGN KEY (product_id) REFERENCES products(id)
  );
```

### Sales — one consolidated table (replaces 6 parallel sets)

#### `sales` — master

```sql
CREATE TABLE sales (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sale_no             BIGSERIAL,                   -- Internal sequential ID
    invoice_no          VARCHAR(30) NOT NULL,        -- Statutory invoice number (from sequence)
    invoice_book_code   VARCHAR(10),                  -- Book identifier
    sale_date           DATE NOT NULL,
    sale_time           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sale_type           VARCHAR(15) NOT NULL,         -- 'RETAIL','WHOLESALE','HOSPITAL','LAB','TAX','COUNTER'
    party_id            UUID NOT NULL,                -- Customer
    account_id          UUID,                         -- Ledger account
    salesman_id         UUID,
    doctor_id           UUID,
    doctor_commission   NUMERIC(15,2) NOT NULL DEFAULT 0,

    -- Amounts
    gross_amount        NUMERIC(15,2) NOT NULL DEFAULT 0,
    discount_pct        NUMERIC(5,2) NOT NULL DEFAULT 0,
    discount_amount     NUMERIC(15,2) NOT NULL DEFAULT 0,
    tax_amount          NUMERIC(15,2) NOT NULL DEFAULT 0,
    further_tax_pct     NUMERIC(5,2) NOT NULL DEFAULT 0,  -- Advanced tax (ATX)
    further_tax_amount  NUMERIC(15,2) NOT NULL DEFAULT 0,
    net_amount          NUMERIC(15,2) NOT NULL DEFAULT 0,
    total_cost          NUMERIC(15,2) NOT NULL DEFAULT 0,  -- COGS
    total_qty           NUMERIC(10,3) NOT NULL DEFAULT 0,
    total_items         INTEGER NOT NULL DEFAULT 0,

    -- Payment
    payment_mode        VARCHAR(10) NOT NULL,         -- 'CASH','CREDIT','BANK'
    cash_received       NUMERIC(15,2) NOT NULL DEFAULT 0,
    balance_amount      NUMERIC(15,2) NOT NULL DEFAULT 0,
    due_date            DATE,

    -- Delivery (DC)
    dc_no               VARCHAR(15),
    dc_date             DATE,
    customer_po_no      VARCHAR(15),
    customer_po_date    DATE,

    -- Tax/Compliance
    customer_ntn        VARCHAR(20),
    customer_is_registered BOOLEAN NOT NULL DEFAULT FALSE, -- On ATL? (determines further tax)
    pos_serial          VARCHAR(20),                  -- FBR POS serial
    fbr_data            JSONB,                        -- FBR response payload
    is_zakat_applicable BOOLEAN NOT NULL DEFAULT FALSE,

    -- Patient (hospital/lab only)
    patient_name        VARCHAR(60),
    patient_id          UUID,

    -- Status
    status              VARCHAR(15) NOT NULL DEFAULT 'DRAFT', -- 'DRAFT','POSTED','VOIDED','ESTIMATE'
    is_estimate         BOOLEAN NOT NULL DEFAULT FALSE,
    posted_at           TIMESTAMPTZ,
    posted_by           UUID,
    voided_at           TIMESTAMPTZ,
    voided_by           UUID,
    void_reason         TEXT,

    remarks             TEXT,
    daily_summary_id    UUID,                         -- FK to daily close summary

    created_by          UUID NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_sales_invoice_no UNIQUE (invoice_no, invoice_book_code), -- FIXES Bug #1
    CONSTRAINT uq_sales_sale_no UNIQUE (sale_no),
    CONSTRAINT ck_sales_type CHECK (sale_type IN ('RETAIL','WHOLESALE','HOSPITAL','LAB','TAX','COUNTER')),
    CONSTRAINT ck_sales_payment CHECK (payment_mode IN ('CASH','CREDIT','BANK')),
    CONSTRAINT ck_sales_status CHECK (status IN ('DRAFT','POSTED','VOIDED','ESTIMATE')),
    CONSTRAINT fk_sales_party FOREIGN KEY (party_id) REFERENCES parties(id),
    CONSTRAINT fk_sales_account FOREIGN KEY (account_id) REFERENCES chart_of_accounts(id),
    CONSTRAINT fk_sales_salesman FOREIGN KEY (salesman_id) REFERENCES salesmen(id),
    CONSTRAINT fk_sales_doctor FOREIGN KEY (doctor_id) REFERENCES doctors(id),
    CONSTRAINT fk_sales_posted_by FOREIGN KEY (posted_by) REFERENCES users(id),
    CONSTRAINT fk_sales_voided_by FOREIGN KEY (voided_by) REFERENCES users(id),
    CONSTRAINT fk_sales_created_by FOREIGN KEY (created_by) REFERENCES users(id)
  );

  CREATE INDEX idx_sales_date ON sales(sale_date);
  CREATE INDEX idx_sales_party ON sales(party_id);
  CREATE INDEX idx_sales_salesman ON sales(salesman_id);
  CREATE INDEX idx_sales_status ON sales(status);
  CREATE INDEX idx_sales_type ON sales(sale_type);
```

#### `sale_lines` — consolidated — replaces DSALE/WDSALE/HDSALE/TDSALE/LDSALE

```sql
CREATE TABLE sale_lines (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sale_id         UUID NOT NULL,
    line_no         INTEGER NOT NULL,                -- Serial (1, 2, 3...)
    product_id      UUID NOT NULL,
    batch_no        VARCHAR(20),                     -- FEFO batch
    expiry_date     DATE,                            -- FEFO expiry
    place_id        UUID NOT NULL,                   -- Where stock is taken from
    pack_qty        NUMERIC(10,3) NOT NULL,
    bonus_qty       NUMERIC(10,3) NOT NULL DEFAULT 0,
    loose_qty       NUMERIC(10,3) NOT NULL DEFAULT 0,
    total_qty       NUMERIC(10,3) NOT NULL,
    rate            NUMERIC(15,2) NOT NULL,          -- Sale rate per pack
    discount_pct    NUMERIC(5,2) NOT NULL DEFAULT 0,
    discount_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
    gst_pct         NUMERIC(5,2) NOT NULL DEFAULT 0,
    gst_amount      NUMERIC(15,2) NOT NULL DEFAULT 0,
    amount          NUMERIC(15,2) NOT NULL,          -- qty × rate (before discount)
    net_amount      NUMERIC(15,2) NOT NULL,          -- After discount + tax
    cost_per_unit   NUMERIC(15,2) NOT NULL,          -- COGS from AVCOST at sale time
    total_cost      NUMERIC(15,2) NOT NULL,          -- qty × cost_per_unit
    is_narcotic     BOOLEAN NOT NULL DEFAULT FALSE,

    CONSTRAINT uq_sale_lines UNIQUE (sale_id, line_no),  -- One product per line no
    CONSTRAINT fk_sl_sale FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE,
    CONSTRAINT fk_sl_product FOREIGN KEY (product_id) REFERENCES products(id),
    CONSTRAINT fk_sl_place FOREIGN KEY (place_id) REFERENCES places(id)
    -- NOTE: NO composite key including cost/expiry (fixes Bug #8)
  );
```

#### `sale_returns`

```sql
CREATE TABLE sale_returns (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    return_no       VARCHAR(20) NOT NULL,
    return_date     DATE NOT NULL,
    original_sale_id UUID NOT NULL,                  -- FK to original sale
    original_invoice_no VARCHAR(30),
    party_id        UUID NOT NULL,
    salesman_id     UUID,
    total_amount    NUMERIC(15,2) NOT NULL DEFAULT 0,
    total_cost      NUMERIC(15,2) NOT NULL DEFAULT 0, -- COGS reversal
    refund_mode     VARCHAR(10),                     -- 'CASH','CREDIT_NOTE'
    refund_amount   NUMERIC(15,2) NOT NULL DEFAULT 0,
    restock         BOOLEAN NOT NULL DEFAULT TRUE,   -- Are goods resalable?
    reason          TEXT NOT NULL,
    approved_by     UUID,
    approved_at     TIMESTAMPTZ,
    is_posted       BOOLEAN NOT NULL DEFAULT FALSE,
    posted_at       TIMESTAMPTZ,
    posted_by       UUID,
    created_by      UUID NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_sreturn_no UNIQUE (return_no),
    CONSTRAINT ck_sr_refund CHECK (refund_mode IN ('CASH','CREDIT_NOTE')),
    CONSTRAINT fk_sr_sale FOREIGN KEY (original_sale_id) REFERENCES sales(id),
    CONSTRAINT fk_sr_party FOREIGN KEY (party_id) REFERENCES parties(id),
    CONSTRAINT fk_sr_posted_by FOREIGN KEY (posted_by) REFERENCES users(id),
    CONSTRAINT fk_sr_approved_by FOREIGN KEY (approved_by) REFERENCES users(id),
    CONSTRAINT fk_sr_created_by FOREIGN KEY (created_by) REFERENCES users(id)
  );

  CREATE TABLE sale_return_lines (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    return_id       UUID NOT NULL,
    product_id      UUID NOT NULL,
    batch_no        VARCHAR(20),
    expiry_date     DATE,
    quantity        NUMERIC(10,3) NOT NULL,
    rate            NUMERIC(15,2) NOT NULL,
    cost_per_unit   NUMERIC(15,2) NOT NULL,
    amount          NUMERIC(15,2) NOT NULL,
    total_cost      NUMERIC(15,2) NOT NULL,

    CONSTRAINT fk_srl_return FOREIGN KEY (return_id) REFERENCES sale_returns(id) ON DELETE CASCADE,
    CONSTRAINT fk_srl_product FOREIGN KEY (product_id) REFERENCES products(id)
  );
```

### Finance & GL

#### `chart_of_accounts`

```sql
CREATE TABLE chart_of_accounts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code            VARCHAR(15) NOT NULL,            -- XX-XX-XX-0000 format
    name            VARCHAR(60) NOT NULL,
    account_type    VARCHAR(15) NOT NULL,            -- 'ASSET','LIABILITY','EQUITY','REVENUE','COGS','EXPENSE'
    parent_id       UUID,                             -- Parent account (hierarchy)
    level           INTEGER NOT NULL,                -- 1=head, 2=sub, 3=control, 4=transaction
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    opening_balance NUMERIC(15,2) NOT NULL DEFAULT 0,
    balance_type    VARCHAR(6) NOT NULL DEFAULT 'DEBIT', -- 'DEBIT' or 'CREDIT' nature
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_coa_code UNIQUE (code),
    CONSTRAINT uq_coa_name UNIQUE (name),
    CONSTRAINT ck_coa_type CHECK (account_type IN ('ASSET','LIABILITY','EQUITY','REVENUE','COGS','EXPENSE')),
    CONSTRAINT ck_coa_balance CHECK (balance_type IN ('DEBIT','CREDIT')),
    CONSTRAINT fk_coa_parent FOREIGN KEY (parent_id) REFERENCES chart_of_accounts(id)
  );
```

NON-NEGOTIABLE: Pakistan COA structure must be seeded:

```text
10-00-00     Assets
  10-01-00   Current Assets
    10-01-01 Cash in Hand
    10-01-02 Cash at Bank
    10-01-03 Debtors
    10-01-04 Bills Receivable
    10-01-05 Stock in Trade
    10-01-06 Securities
    10-01-07 Advance to Staff
  10-02-00   Fixed Assets
    10-02-01 Buildings
    10-02-05 Vehicle
20-00-00     Liabilities & Equity
  20-01-00   Current Liabilities
    20-01-01 Creditors
  20-02-00   Owner's Equity
    20-02-00-0000 Capital Account
40-00-00     Revenue
  40-01-00   Sales
    40-01-01 Sale Returns
50-00-00     COGS
  50-01-00   Opening Stock
  50-02-00   Purchases
60-00-00     Expenses
  60-01-00   Selling & Distribution Expenses
  60-02-00   Office & Admin Expenses
    60-02-05 Gifts/Breakage
```

#### `fiscal_periods` — replaces DATASECURE

```sql
CREATE TABLE fiscal_periods (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    period_name     VARCHAR(20) NOT NULL,            -- e.g., "JUL-2025"
    fiscal_year     INTEGER NOT NULL,                -- e.g., 2025
    period_month    INTEGER NOT NULL,                -- 1-12
    start_date      DATE NOT NULL,
    end_date        DATE NOT NULL,
    status          VARCHAR(10) NOT NULL DEFAULT 'OPEN', -- 'OPEN','CLOSED','LOCKED'
    closed_at       TIMESTAMPTZ,
    closed_by       UUID,

    CONSTRAINT uq_fp_name UNIQUE (period_name),
    CONSTRAINT uq_fp_dates UNIQUE (start_date, end_date),
    CONSTRAINT ck_fp_status CHECK (status IN ('OPEN','CLOSED','LOCKED')),
    CONSTRAINT ck_fp_month CHECK (period_month BETWEEN 1 AND 12),
    CONSTRAINT fk_fp_closed_by FOREIGN KEY (closed_by) REFERENCES users(id)
  );
```

NON-NEGOTIABLE: Posting to CLOSED/LOCKED periods is blocked at the DB level.

```sql
CREATE OR REPLACE FUNCTION fn_block_closed_period()
  RETURNS TRIGGER AS $$
  BEGIN
    IF EXISTS (
        SELECT 1 FROM fiscal_periods
        WHERE status IN ('CLOSED','LOCKED')
          AND NEW.entry_date BETWEEN start_date AND end_date
    ) THEN
        RAISE EXCEPTION 'Cannot post to a closed/locked fiscal period';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;
```

#### `journal_entries` — JV header — replaces MGENERAL + GENERAL header

```sql
CREATE TABLE journal_entries (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entry_no        VARCHAR(20) NOT NULL,            -- E number (sequential)
    entry_date      DATE NOT NULL,
    entry_type      VARCHAR(5) NOT NULL,             -- 'JV','PV','RV','OP','SV' (sale voucher)
    fiscal_year     INTEGER NOT NULL,
    fiscal_month    VARCHAR(10) NOT NULL,
    reference_type  VARCHAR(15),                     -- 'SALE','PURCHASE','CASH','BANK','RETURN','ADJUSTMENT'
    reference_id    UUID,                            -- FK to source transaction
    reference_no    VARCHAR(30),                     -- Human-readable ref (invoice no, etc.)
    total_debit     NUMERIC(15,2) NOT NULL DEFAULT 0,
    total_credit    NUMERIC(15,2) NOT NULL DEFAULT 0,
    is_balanced     BOOLEAN GENERATED ALWAYS AS (total_debit = total_credit) STORED,
    is_posted       BOOLEAN NOT NULL DEFAULT FALSE,
    posted_at       TIMESTAMPTZ,
    narration       TEXT,
    created_by      UUID NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_je_entry_no UNIQUE (entry_no),
    CONSTRAINT ck_je_type CHECK (entry_type IN ('JV','PV','RV','OP','SV')),
    CONSTRAINT ck_je_balanced CHECK (total_debit = total_credit),  -- NON-NEGOTIABLE: JV must balance
    CONSTRAINT fk_je_created_by FOREIGN KEY (created_by) REFERENCES users(id)
  );
```

#### `journal_lines` — JV lines — replaces GENERAL detail

```sql
CREATE TABLE journal_lines (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entry_id        UUID NOT NULL,                   -- FK to journal_entries
    line_no         INTEGER NOT NULL,                -- S number (serial within voucher)
    account_id      UUID NOT NULL,                   -- FK to chart_of_accounts
    account_code    VARCHAR(15) NOT NULL,            -- Denormalized for audit
    account_name    VARCHAR(60) NOT NULL,            -- Denormalized for audit
    debit_amount    NUMERIC(15,2) NOT NULL DEFAULT 0,
    credit_amount   NUMERIC(15,2) NOT NULL DEFAULT 0,
    narration       TEXT,

    CONSTRAINT uq_jl UNIQUE (entry_id, line_no),
    CONSTRAINT ck_jl_debit_or_credit CHECK (
        (debit_amount > 0 AND credit_amount = 0) OR
        (credit_amount > 0 AND debit_amount = 0) OR
        (debit_amount = 0 AND credit_amount = 0)
    ),
    CONSTRAINT fk_jl_entry FOREIGN KEY (entry_id) REFERENCES journal_entries(id) ON DELETE CASCADE,
    CONSTRAINT fk_jl_account FOREIGN KEY (account_id) REFERENCES chart_of_accounts(id)
  );
```

#### `cash_vouchers`

```sql
CREATE TABLE cash_vouchers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    voucher_no      VARCHAR(20) NOT NULL,            -- Sequential (from seq_voucher_no)
    voucher_date    DATE NOT NULL,
    voucher_type    VARCHAR(10) NOT NULL,            -- 'RECEIPT' or 'PAYMENT'
    party_id        UUID NOT NULL,
    account_id      UUID NOT NULL,                   -- Cash account (10-01-01)
    amount          NUMERIC(15,2) NOT NULL,
    narration       TEXT,
    due_date        DATE,
    is_cleared      BOOLEAN NOT NULL DEFAULT TRUE,   -- Cash is always cleared
    salesman_id     UUID,
    is_posted       BOOLEAN NOT NULL DEFAULT FALSE,
    posted_at       TIMESTAMPTZ,
    posted_by       UUID,
    created_by      UUID NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_cv_no UNIQUE (voucher_no),
    CONSTRAINT ck_cv_type CHECK (voucher_type IN ('RECEIPT','PAYMENT')),
    CONSTRAINT fk_cv_party FOREIGN KEY (party_id) REFERENCES parties(id),
    CONSTRAINT fk_cv_account FOREIGN KEY (account_id) REFERENCES chart_of_accounts(id),
    CONSTRAINT fk_cv_posted_by FOREIGN KEY (posted_by) REFERENCES users(id),
    CONSTRAINT fk_cv_created_by FOREIGN KEY (created_by) REFERENCES users(id)
  );
```

> The source transcript ends here, mid-`bank_vouchers`. The remaining tables are in Part 4.

---

## Part 4 — Tables missing from Part 3 *(from an earlier pass)*

Part 3 was cut off mid-`bank_vouchers`. The definitions below come from earlier renditions
of the same spec and use `erp.<schema>.<table>` qualified names; treat the naming as
illustrative and the columns as the reference.

### Sales — estimates, delivery, routes, commissions

```sql
CREATE TABLE erp.sales.estimates (
    estimate_id     BIGSERIAL PRIMARY KEY,
    estimate_no      VARCHAR(20) NOT NULL UNIQUE,
    estimate_date    DATE NOT NULL,
    party_id         BIGINT NOT NULL REFERENCES erp.masters.parties(party_id),
    salesman_id      BIGINT REFERENCES erp.masters.salesmen(salesman_id),
    valid_until      DATE,
    total_amount     NUMERIC(14,2) DEFAULT 0,
    status           VARCHAR(10) DEFAULT 'OPEN',  -- OPEN, CONVERTED, EXPIRED, CANCELLED
    converted_sale_id BIGINT REFERENCES erp.sales.sales(sale_id),
    created_by       VARCHAR(30) NOT NULL,
    created_at       TIMESTAMPTZ DEFAULT now()
);

-- Delivery Challans
CREATE TABLE erp.sales.delivery_challans (
    dc_id            BIGSERIAL PRIMARY KEY,
    dc_no            VARCHAR(20) NOT NULL UNIQUE,
    dc_date          DATE NOT NULL,
    sale_id          BIGINT REFERENCES erp.sales.sales(sale_id),
    party_id         BIGINT NOT NULL REFERENCES erp.masters.parties(party_id),
    driver_name      VARCHAR(30),
    vehicle_no       VARCHAR(15),
    route_id         BIGINT REFERENCES erp.sales.routes(route_id),
    status           VARCHAR(10) DEFAULT 'PENDING',  -- PENDING, IN_TRANSIT, DELIVERED, CONFIRMED
    delivered_at     TIMESTAMPTZ,
    confirmed_at     TIMESTAMPTZ,
    proof_image_path VARCHAR(200),
    created_by       VARCHAR(30) NOT NULL,
    created_at       TIMESTAMPTZ DEFAULT now()
);

-- Routes
CREATE TABLE erp.sales.routes (
    route_id         BIGSERIAL PRIMARY KEY,
    route_name       VARCHAR(30) NOT NULL UNIQUE,
    route_code       VARCHAR(10) NOT NULL UNIQUE,
    description      VARCHAR(100),
    is_active         BOOLEAN DEFAULT true
);

-- Salesman Targets
CREATE TABLE erp.sales.salesman_targets (
    target_id        BIGSERIAL PRIMARY KEY,
    salesman_id      BIGINT NOT NULL REFERENCES erp.masters.salesmen(salesman_id),
    period_month     INTEGER NOT NULL,  -- 1-12
    period_year      INTEGER NOT NULL,
    target_amount    NUMERIC(14,2) NOT NULL,
    target_qty       INTEGER,
    target_customers INTEGER,
    achieved_amount  NUMERIC(14,2) DEFAULT 0,
    achieved_qty     INTEGER DEFAULT 0,
    UNIQUE(salesman_id, period_month, period_year)
);

-- Commissions
CREATE TABLE erp.sales.commissions (
    commission_id    BIGSERIAL PRIMARY KEY,
    salesman_id      BIGINT NOT NULL REFERENCES erp.masters.salesmen(salesman_id),
    period_month     INTEGER NOT NULL,
    period_year      INTEGER NOT NULL,
    total_sales      NUMERIC(14,2),
    commission_rate  NUMERIC(5,2),
    commission_amount NUMERIC(14,2),
    is_paid          BOOLEAN DEFAULT false,
    paid_at          TIMESTAMPTZ,
    UNIQUE(salesman_id, period_month, period_year)
);
```

### Finance — bank, petty cash, drawings, expenses

```sql
CREATE TABLE erp.finance.bank_vouchers (
    bank_voucher_id  BIGSERIAL PRIMARY KEY,
    voucher_no       VARCHAR(20) NOT NULL UNIQUE,
    voucher_date     DATE NOT NULL,
    voucher_type     CHAR(1) NOT NULL,  -- R=Receipt, P=Payment
    bank_account_id  BIGINT NOT NULL REFERENCES erp.finance.accounts(account_id),
    party_id         BIGINT REFERENCES erp.masters.parties(party_id),
    amount           NUMERIC(14,2) NOT NULL,
    cheque_no        VARCHAR(30),
    cheque_date      DATE,
    due_date         DATE,
    is_cleared       BOOLEAN DEFAULT false,
    cleared_at       TIMESTAMPTZ,
    amount_in_words  VARCHAR(200),
    is_posted        BOOLEAN DEFAULT false,
    posted_at        TIMESTAMPTZ,
    created_by       VARCHAR(30) NOT NULL,
    created_at       TIMESTAMPTZ DEFAULT now()
);

-- Petty Cash
CREATE TABLE erp.finance.petty_cash (
    petty_id         BIGSERIAL PRIMARY KEY,
    entry_date       DATE NOT NULL,
    description      VARCHAR(100),
    debit_amount     NUMERIC(14,2) DEFAULT 0,
    credit_amount    NUMERIC(14,2) DEFAULT 0,
    balance          NUMERIC(14,2) DEFAULT 0,
    created_by       VARCHAR(30) NOT NULL,
    created_at       TIMESTAMPTZ DEFAULT now()
);

-- Drawings (owner withdrawals)
CREATE TABLE erp.finance.drawings (
    drawing_id       BIGSERIAL PRIMARY KEY,
    drawing_date     DATE NOT NULL,
    amount           NUMERIC(14,2) NOT NULL,
    description      VARCHAR(100),
    created_by       VARCHAR(30) NOT NULL,
    created_at       TIMESTAMPTZ DEFAULT now()
);

-- Expenses
CREATE TABLE erp.finance.expenses (
    expense_id       BIGSERIAL PRIMARY KEY,
    expense_date     DATE NOT NULL,
    account_id       BIGINT NOT NULL REFERENCES erp.finance.accounts(account_id),
    amount           NUMERIC(14,2) NOT NULL,
    description      VARCHAR(100),
    created_by       VARCHAR(30) NOT NULL,
    created_at       TIMESTAMPTZ DEFAULT now()
);
```

### Inventory — shelf locations

##### `shelf_locations`

| Column | Type | Constraints |
|---|---|---|
| id | BIGSERIAL | PK |
| product_id | BIGINT | FK → products.id |
| shelf_code | VARCHAR(20) | e.g., "A-3-2" |
| place_code | CHAR(1) | 'S' or 'W' |

### Control & audit — audit log, invoice books, settings, stock views

##### `audit_log` — APPEND-ONLY — tamper-evident

```sql
CREATE TABLE audit.audit_log (
    audit_id     BIGSERIAL PRIMARY KEY,
    audit_time   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    user_id      BIGINT NOT NULL,
    username     VARCHAR(50) NOT NULL,
    table_name   VARCHAR(50) NOT NULL,
    record_id    BIGINT,
    action       VARCHAR(10) NOT NULL,               -- INSERT/UPDATE/DELETE
    old_values   JSONB,                               -- before change
    new_values   JSONB,                               -- after change
    ip_address   VARCHAR(45),
    hash_prev    VARCHAR(64),                         -- previous row's hash (chaining)
    hash_curr    VARCHAR(64),                         -- this row's hash
    CHECK (action IN ('INSERT', 'UPDATE', 'DELETE'))
  ) TABLESPACE app_audit;

  -- NO UPDATE or DELETE privileges on audit_log for ANY role
  -- Only INSERT and SELECT allowed
  REVOKE UPDATE, DELETE ON audit.audit_log FROM PUBLIC;
```

##### `invoice_books` — statutory numbering

```sql
CREATE TABLE config.invoice_books (
    book_id      SERIAL PRIMARY KEY,
    book_code    VARCHAR(20) NOT NULL UNIQUE,        -- 'PBM', 'RET01', etc.
    book_type    VARCHAR(15) NOT NULL,                -- retail/wholesale/tax
    start_no     INTEGER NOT NULL,
    end_no       INTEGER NOT NULL,
    next_no      INTEGER NOT NULL,                   -- next number to assign
    is_active    BOOLEAN DEFAULT TRUE,
    CHECK (end_no > start_no),
    CHECK (next_no BETWEEN start_no AND end_no + 1)
  ) TABLESPACE app_data;
```

##### `settings`

```sql
CREATE TABLE config.settings (
    setting_key   VARCHAR(50) PRIMARY KEY,
    setting_value TEXT NOT NULL,
    setting_desc  VARCHAR(200),
    updated_by    BIGINT REFERENCES config.users(user_id),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
  ) TABLESPACE app_data;
```

##### Stock views (derived — never cached)

```sql
-- ⚠ REJECTED — do not copy. Retained to show what must not be built.
  --
  --   COALESCE(SUM(m.qty_in - m.qty_out), 0) * p.avcost AS stock_value
  --
  -- That is quantity × a rounded average: the recomputation ADR-0015 §7
  -- forbids, and the defect that ADR record exists to prevent. It also
  -- reads `avcost` off `products`, which ADR-0015 closes. Three separate
  -- views replace it, because "current stock" was doing three jobs at once
  -- and the authoritative one must never filter.

  -- 1. AUTHORITATIVE balances — ALL of them, including unexpected negatives.
  --    Never filtered. A negative here is a fact to be reported, not hidden.
  CREATE VIEW transactions.v_stock_balances AS
  SELECT p.product_id, p.product_code, p.product_name, p.company_name,
       COALESCE(SUM(m.qty_in - m.qty_out), 0) AS current_qty,
       COALESCE(SUM(m.inventory_value_delta), 0) AS stock_value
  FROM masters.products p
  LEFT JOIN transactions.stock_movements m ON p.product_id = m.product_id
  GROUP BY p.product_id, p.product_code, p.product_name, p.company_name;
  -- stock_value is the SUM OF SIGNED STORED VALUE MOVEMENTS. Never a product
  -- of quantity and a rate. Average cost is a separate rate and is not here.

  -- 2. PICKER — eligible positive stock only. Filtering is correct HERE and
  --    only here, because its job is "what may I sell", not "what is true".
  CREATE VIEW transactions.v_available_stock AS
  SELECT * FROM transactions.v_stock_balances WHERE current_qty > 0;

  -- 3. EXCEPTION REPORT — reads the AUTHORITATIVE view, not the picker.
  --    Sourcing this from a view that excludes negatives makes it
  --    permanently empty, which is how a corruption report becomes a
  --    corruption concealer.
  CREATE VIEW transactions.v_negative_stock AS
  SELECT * FROM transactions.v_stock_balances WHERE current_qty < 0;

  -- Shop stock (place='S', >0, with batch+expiry)
  CREATE VIEW transactions.v_shop_stock AS
  SELECT m.product_id, m.product_name, m.batch_no, m.expiry_date,
       SUM(m.qty_in - m.qty_out) AS qty,
       m.cost_per_unit, m.sale_rate, m.company_name
  FROM transactions.stock_movements m
  WHERE m.place = 'S'
  GROUP BY m.product_id, m.product_name, m.batch_no, m.expiry_date,
         m.cost_per_unit, m.sale_rate, m.company_name
  HAVING SUM(m.qty_in - m.qty_out) > 0;

  -- Reorder demand
  CREATE VIEW transactions.v_reorder_demand AS
  SELECT p.product_id, p.product_code, p.product_name, p.company_name,
       p.reorder_level,
       COALESCE(s.current_qty, 0) AS current_stock,
       p.reorder_level - COALESCE(s.current_qty, 0) AS demand_qty
  FROM masters.products p
  LEFT JOIN transactions.v_current_stock s ON p.product_id = s.product_id
  WHERE p.is_active = TRUE
    AND p.reorder_level > COALESCE(s.current_qty, 0);
```

### Costing, tax & compliance, HR, audit log *(compact rendition)*

#### Costing

```sql
-- Cost history (tracks AVCOST changes)
  CREATE TABLE cost_history (
    id BIGSERIAL PRIMARY KEY,
    product_id BIGINT NOT NULL REFERENCES products(id),
    old_cost DECIMAL(12,2),
    new_cost DECIMAL(12,2),
    change_date TIMESTAMPTZ DEFAULT NOW(),
    change_reason VARCHAR(100),                    -- 'purchase','adjustment','manual'
    transaction_id BIGINT,
    created_by BIGINT REFERENCES users(id)
  );

  -- Batch valuation (view — not a staging table)
  CREATE VIEW v_batch_valuation AS
  SELECT sm.product_id, sm.batch_id, p.name,
       SUM(sm.qty_in) - SUM(sm.qty_out) AS stock_qty,
       p.avg_cost,
       (SUM(sm.qty_in) - SUM(sm.qty_out)) * p.avg_cost AS stock_value
  FROM stock_movements sm
  JOIN products p ON sm.product_id = p.id
  GROUP BY sm.product_id, sm.batch_id, p.name, p.avg_cost
  HAVING SUM(sm.qty_in) - SUM(sm.qty_out) > 0;
```

#### Tax & compliance

```sql
CREATE TABLE tax_rates (
    id BIGSERIAL PRIMARY KEY,
    tax_type VARCHAR(20) NOT NULL CHECK (tax_type IN ('gst','further_tax','income_tax')),
    rate DECIMAL(5,2) NOT NULL,
    effective_from DATE NOT NULL,
    effective_to DATE,
    is_active BOOLEAN DEFAULT TRUE
  );

  CREATE TABLE narcotic_log (
    id BIGSERIAL PRIMARY KEY,
    transaction_type VARCHAR(20) NOT NULL,
    transaction_id BIGINT NOT NULL,
    product_id BIGINT NOT NULL REFERENCES products(id),
    quantity DECIMAL(15,3) NOT NULL,
    batch_id BIGINT REFERENCES batches(id),
    transaction_date DATE NOT NULL,
    created_by BIGINT REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE fbr_pos_log (
    id BIGSERIAL PRIMARY KEY,
    sale_id BIGINT NOT NULL REFERENCES sales(id),
    pos_serial VARCHAR(20),
    fbr_invoice_number VARCHAR(30),
    fbr_response TEXT,
    submitted_at TIMESTAMPTZ,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','submitted','accepted','rejected'))
  );
```

#### HR & attendance

```sql
CREATE TABLE employees (
    id BIGSERIAL PRIMARY KEY,
    code VARCHAR(10) UNIQUE NOT NULL,
    name VARCHAR(60) NOT NULL,
    designation VARCHAR(30),
    department_id BIGINT REFERENCES departments(id),
    salary DECIMAL(12,2) DEFAULT 0,
    allowance DECIMAL(12,2) DEFAULT 0,
    duty_hours INTEGER DEFAULT 8,
    status VARCHAR(1) DEFAULT 'A',
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE attendance (
    id BIGSERIAL PRIMARY KEY,
    employee_id BIGINT NOT NULL REFERENCES employees(id),
    attend_date DATE NOT NULL,
    in_time TIMESTAMPTZ,
    out_time TIMESTAMPTZ,
    hours_worked DECIMAL(4,1),
    rate DECIMAL(10,2),
    bonus DECIMAL(10,2) DEFAULT 0,
    advance DECIMAL(10,2) DEFAULT 0,
    gross_amount DECIMAL(12,2),
    is_off_day BOOLEAN DEFAULT FALSE,
    UNIQUE (employee_id, attend_date)
  );
```

#### Audit log (append-only)

```sql
CREATE TABLE audit_log (
    id BIGSERIAL PRIMARY KEY,
    table_name VARCHAR(50) NOT NULL,
    record_id BIGINT NOT NULL,
    action VARCHAR(10) NOT NULL CHECK (action IN ('INSERT','UPDATE','DELETE')),
    old_values JSONB,
    new_values JSONB,
    changed_by BIGINT NOT NULL REFERENCES users(id),
    changed_at TIMESTAMPTZ DEFAULT NOW(),
    ip_address VARCHAR(45),
    hash_previous VARCHAR(64),                     -- hash chaining for tamper-evidence
    hash_current VARCHAR(64)
    -- NO UPDATE or DELETE allowed on this table (enforced by trigger/app)
  );
```

---

## Part 5 — Data formats & conventions

### Code formats

| Entity | Format | Example | Rule |
|---|---|---|---|
| Chart of Accounts | XX-XX-XX-0000 | 10-01-01-0001 | 4-level hierarchy (head/subhead/control/transaction) |
| Product code | Alphanumeric, max 20 | PAN500MG | Unique, system or manual |
| Customer code | Alphanumeric, max 20 | CUST001 | Unique |
| Vendor code | Alphanumeric, max 20 | VEND001 | Unique |
| Sale number | Auto-sequence | S000001 | System-generated, non-reusable |
| Purchase/GRN number | Auto-sequence | GRN00001 | System-generated, non-reusable |
| Invoice book number | BOOK-SEQ | PBM-0001 | Unique per book, statutory |
| PO number | Auto-sequence | PO00001 | System-generated |
| JV number | Auto-sequence | JV00001 | System-generated, E number |
| Cash voucher | CV-R/P-SEQ | CV-R00001 | Receipt or Payment |
| Bank voucher | BV-R/P-SEQ | BV-P00001 | Receipt or Payment |

### Number formats

| Field | Type | Precision | Notes |
|---|---|---|---|
| Quantities | DECIMAL(15,3) | 3 decimal places | Supports loose units (e.g., 0.5 strips) |
| Monetary amounts | DECIMAL(15,2) | 2 decimal places | Rupees and paisa |
| Rates/prices | DECIMAL(12,2) | 2 decimal places | Per pack or per unit |
| Cost (AVCOST) | DECIMAL(12,4) | 4 decimal places | Weighted average needs precision |
| Percentages (GST, discount) | DECIMAL(5,2) | 2 decimal places | e.g., 12.00 for 12% |
| Stock quantity (derived) | ROUND(..., 3) | 3 decimal places | Matches movement precision |

### Date formats

| Field | Format | Notes |
|---|---|---|
| Transaction dates | DATE | YYYY-MM-DD (no time component) |
| Timestamps | TIMESTAMPTZ | YYYY-MM-DD HH:MI:SS+TZ — for audit trails |
| Expiry dates | DATE | From product packaging |
| Due dates | DATE | Calculated from transaction date + credit days |

### Status enums

| Entity | Valid statuses | Transition rule |
|---|---|---|
| Sale | draft → posted → void | Draft can be edited; posted cannot (use reversal); void requires reason |
| Purchase/GRN | draft → posted | Same |
| JV | draft → posted | Same |
| Fiscal period | open → closed → locked | Locked = archived, cannot reopen |
| Cheque | pending → cleared / dishonoured / cancelled | One-way transitions |
| Customer/Vendor | A (active) / I (inactive) | Inactive = no new transactions |

---

## Part 6 — Non-negotiables asserted by this source material

These are the rules the source document repeats and enforces in DDL. They are consistent
with FinSoft's own invariants, but [docs/NON_NEGOTIABLES.md](../docs/NON_NEGOTIABLES.md)
remains the authority:

1. **Stock is never a stored column.** It is always `SUM(qty_in) - SUM(qty_out)` over
   `stock_movements`, exposed through `v_current_stock` / `v_batch_stock`.
2. **Application data never lives in the system catalog tablespace.** The legacy system
   put every table in `SYSTEM`; dedicated tablespaces are mandatory.
3. **Every transaction line has a foreign key to its master.** The legacy system had 13
   FKs, 3 of them disabled, and orphan sale lines as a result.
4. **Document numbers come from sequences/identity, never `MAX(id)+1`.** `MAX+1` produced
   duplicate invoice numbers in the legacy system.
5. **One sale table with a `sale_type` discriminator** — not six parallel table sets
   (`MSALE`/`WMSALE`/`HMSALE`/`LMSALE`/`TMSALE`/`STPSAL`), which was the root cause of
   reports reading an empty table.
6. **A journal entry must balance**: `CHECK (total_debit = total_credit)`, and each line
   carries debit XOR credit — never both, never neither.
7. **Posting to a CLOSED or LOCKED fiscal period is blocked at the database level**, by
   trigger, not by application code alone.
8. **The Pakistan chart of accounts structure is seeded**, not invented per install.
9. **`vendor_products` must exist.** Without it the question "which vendors supply this
   product?" cannot be answered — a real gap in the legacy schema.
10. **The audit log is append-only and hash-chained**; `UPDATE` and `DELETE` are revoked.
