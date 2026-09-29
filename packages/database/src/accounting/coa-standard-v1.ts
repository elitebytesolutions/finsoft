/*
 * The COA/standard-v1 template. docs/posting-rules/coa-standard.md §2.
 *
 * This is DATA, not a decision this package makes — the Accounting seat owns
 * the template, this is its transcription. `standard-v1` is frozen from the
 * first tenant seeded with it (coa-standard.md §7): a change is
 * `standard-v2`, a new export, never an edit of this array.
 */

export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE'
export type NormalBalance = 'DEBIT' | 'CREDIT'
export type AccountKind = 'HEADER' | 'POSTABLE'
/** ADR-0026: 'NONE' for a non-control account — never null (migration 010). */
export type ControlKind = 'NONE' | 'AR' | 'AP' | 'INVENTORY'

export interface AccountTemplateEntry {
  readonly code: string
  readonly name: string
  readonly type: AccountType
  readonly normalBalance: NormalBalance
  readonly kind: AccountKind
  readonly controlKind: ControlKind
  /** The role a posting rule names (AR_CONTROL, CASH_DEFAULT, ...), or null. */
  readonly role: string | null
  /** coa-standard.md §3: closed to manual JV for a reason OTHER than being a control account. */
  readonly restricted: boolean
  /** The header this account is filed under, by code. Null for a header itself. */
  readonly parentCode: string | null
}

export const STANDARD_V1: readonly AccountTemplateEntry[] = [
  {
    code: '1000',
    name: 'Assets',
    type: 'ASSET',
    normalBalance: 'DEBIT',
    kind: 'HEADER',
    controlKind: 'NONE',
    role: null,
    restricted: false,
    parentCode: null,
  },
  {
    code: '1110',
    name: 'Cash in Hand',
    type: 'ASSET',
    normalBalance: 'DEBIT',
    kind: 'POSTABLE',
    controlKind: 'NONE',
    role: 'CASH_DEFAULT',
    restricted: false,
    parentCode: '1000',
  },
  {
    code: '1120',
    name: 'Bank - Current Account',
    type: 'ASSET',
    normalBalance: 'DEBIT',
    kind: 'POSTABLE',
    controlKind: 'NONE',
    role: 'BANK_DEFAULT',
    restricted: false,
    parentCode: '1000',
  },
  {
    code: '1200',
    name: 'Accounts Receivable - Trade Debtors',
    type: 'ASSET',
    normalBalance: 'DEBIT',
    kind: 'POSTABLE',
    controlKind: 'AR',
    role: 'AR_CONTROL',
    restricted: false,
    parentCode: '1000',
  },
  {
    code: '1300',
    name: 'Inventory - Stock in Trade',
    type: 'ASSET',
    normalBalance: 'DEBIT',
    kind: 'POSTABLE',
    controlKind: 'INVENTORY',
    role: 'INVENTORY',
    restricted: false,
    parentCode: '1000',
  },

  {
    code: '2000',
    name: 'Liabilities',
    type: 'LIABILITY',
    normalBalance: 'CREDIT',
    kind: 'HEADER',
    controlKind: 'NONE',
    role: null,
    restricted: false,
    parentCode: null,
  },
  {
    code: '2100',
    name: 'Accounts Payable - Trade Creditors',
    type: 'LIABILITY',
    normalBalance: 'CREDIT',
    kind: 'POSTABLE',
    controlKind: 'AP',
    role: 'AP_CONTROL',
    restricted: false,
    parentCode: '2000',
  },
  {
    code: '2900',
    name: 'Suspense',
    type: 'LIABILITY',
    normalBalance: 'CREDIT',
    kind: 'POSTABLE',
    controlKind: 'NONE',
    role: 'SUSPENSE',
    restricted: false,
    parentCode: '2000',
  },

  {
    code: '3000',
    name: 'Equity',
    type: 'EQUITY',
    normalBalance: 'CREDIT',
    kind: 'HEADER',
    controlKind: 'NONE',
    role: null,
    restricted: false,
    parentCode: null,
  },
  {
    code: '3100',
    name: "Owner's Capital",
    type: 'EQUITY',
    normalBalance: 'CREDIT',
    kind: 'POSTABLE',
    controlKind: 'NONE',
    role: 'OWNER_CAPITAL',
    restricted: false,
    parentCode: '3000',
  },
  {
    code: '3200',
    name: 'Retained Earnings',
    type: 'EQUITY',
    normalBalance: 'CREDIT',
    kind: 'POSTABLE',
    controlKind: 'NONE',
    role: 'RETAINED_EARNINGS',
    restricted: true,
    parentCode: '3000',
  },
  {
    code: '3300',
    name: "Owner's Drawings",
    type: 'EQUITY',
    normalBalance: 'DEBIT',
    kind: 'POSTABLE',
    controlKind: 'NONE',
    role: 'OWNER_DRAWINGS',
    restricted: false,
    parentCode: '3000',
  },

  {
    code: '4000',
    name: 'Income',
    type: 'INCOME',
    normalBalance: 'CREDIT',
    kind: 'HEADER',
    controlKind: 'NONE',
    role: null,
    restricted: false,
    parentCode: null,
  },
  {
    code: '4100',
    name: 'Sales Revenue - Goods',
    type: 'INCOME',
    normalBalance: 'CREDIT',
    kind: 'POSTABLE',
    controlKind: 'NONE',
    role: 'SALES_REVENUE',
    restricted: false,
    parentCode: '4000',
  },
  {
    code: '4200',
    name: 'Service Revenue',
    type: 'INCOME',
    normalBalance: 'CREDIT',
    kind: 'POSTABLE',
    controlKind: 'NONE',
    role: 'SERVICE_REVENUE',
    restricted: false,
    parentCode: '4000',
  },
  {
    code: '4900',
    name: 'Other Income',
    type: 'INCOME',
    normalBalance: 'CREDIT',
    kind: 'POSTABLE',
    controlKind: 'NONE',
    role: null,
    restricted: false,
    parentCode: '4000',
  },

  {
    code: '5000',
    name: 'Cost of Sales',
    type: 'EXPENSE',
    normalBalance: 'DEBIT',
    kind: 'HEADER',
    controlKind: 'NONE',
    role: null,
    restricted: false,
    parentCode: null,
  },
  {
    code: '5100',
    name: 'Cost of Goods Sold',
    type: 'EXPENSE',
    normalBalance: 'DEBIT',
    kind: 'POSTABLE',
    controlKind: 'NONE',
    role: 'COGS',
    restricted: true,
    parentCode: '5000',
  },

  {
    code: '6000',
    name: 'Operating Expenses',
    type: 'EXPENSE',
    normalBalance: 'DEBIT',
    kind: 'HEADER',
    controlKind: 'NONE',
    role: null,
    restricted: false,
    parentCode: null,
  },
  {
    code: '6100',
    name: 'Salaries and Wages',
    type: 'EXPENSE',
    normalBalance: 'DEBIT',
    kind: 'POSTABLE',
    controlKind: 'NONE',
    role: null,
    restricted: false,
    parentCode: '6000',
  },
  {
    code: '6200',
    name: 'Rent',
    type: 'EXPENSE',
    normalBalance: 'DEBIT',
    kind: 'POSTABLE',
    controlKind: 'NONE',
    role: null,
    restricted: false,
    parentCode: '6000',
  },
  {
    code: '6300',
    name: 'Office Expenses',
    type: 'EXPENSE',
    normalBalance: 'DEBIT',
    kind: 'POSTABLE',
    controlKind: 'NONE',
    role: null,
    restricted: false,
    parentCode: '6000',
  },
  {
    code: '6400',
    name: 'Utilities',
    type: 'EXPENSE',
    normalBalance: 'DEBIT',
    kind: 'POSTABLE',
    controlKind: 'NONE',
    role: null,
    restricted: false,
    parentCode: '6000',
  },
  {
    code: '6500',
    name: 'Bank Charges',
    type: 'EXPENSE',
    normalBalance: 'DEBIT',
    kind: 'POSTABLE',
    controlKind: 'NONE',
    role: null,
    restricted: false,
    parentCode: '6000',
  },
  {
    code: '6900',
    name: 'Rounding Differences',
    type: 'EXPENSE',
    normalBalance: 'DEBIT',
    kind: 'POSTABLE',
    controlKind: 'NONE',
    role: 'ROUNDING',
    restricted: true,
    parentCode: '6000',
  },
] as const

export const COA_TEMPLATE_ID = 'COA/standard-v1'
