'use client'
/*
 * /accounts — docs/design-system/pages/chart-of-accounts/README.md.
 * Real API from M2-S: GET /api/accounts (the tree) + GET /api/reports/trial-balance (balances,
 * for accounts with activity — the accounts endpoint itself carries no balance field). Read-only:
 * coa-standard.md §5, "the MVP ships the chart read-only to users" — Add/Edit/Move/Delete/
 * Activate/Deactivate/Import are removed, not disabled placeholders (nothing to disable-with-
 * tooltip when the whole affordance has zero available mutations).
 */
import { useMemo } from 'react'
import { RotateCw, ShieldAlert } from 'lucide-react'
import { Badge, Banner, Button, PageHead, Table, moneyFromString } from '@finsoft/ui'
import { Money } from '@finsoft/validation'
import { useNavigate } from '@/lib/router'
import { listAccounts, getTrialBalance } from '@/lib/api/accounting-client'
import { useApiQuery } from '@/lib/api/use-api-query'
import { buildAccountTree, flattenAccountTree } from '@/lib/accounting/account-tree'
import { todayIso } from '@/lib/date/local-date'
import type { AccountDto, TrialBalanceLine } from '@/lib/api/accounting-types'

interface ChartData {
  accounts: AccountDto[]
  balances: Map<string, TrialBalanceLine>
}

async function loadChart(): Promise<ChartData> {
  const [accountsRes, trialBalance] = await Promise.all([
    listAccounts(),
    getTrialBalance(todayIso()),
  ])
  return {
    accounts: [...accountsRes.accounts],
    balances: new Map(trialBalance.lines.map((line) => [line.accountId, line])),
  }
}

export function ChartOfAccounts() {
  const { state, reload } = useApiQuery(loadChart, [])

  return (
    <div className="coa2">
      <PageHead
        eyebrow="Accounting"
        title="Chart of Accounts"
        description="The account structure every posting surface picks from. Read-only in this release."
      />

      {state.status === 'loading' && (
        <div className="state-page" role="status" aria-live="polite">
          <span>
            <RotateCw />
          </span>
          <h1>Loading the chart of accounts…</h1>
        </div>
      )}

      {state.status === 'forbidden' && (
        <div className="state-page" role="alert">
          <span>
            <ShieldAlert />
          </span>
          <h1>Access restricted</h1>
          <p>Your role does not have permission to view the chart of accounts.</p>
        </div>
      )}

      {state.status === 'error' && (
        <div className="state-page" role="alert">
          <span>
            <ShieldAlert />
          </span>
          <h1>We could not load the chart of accounts</h1>
          <p>{state.message}</p>
          <Button onClick={reload}>Try again</Button>
        </div>
      )}

      {state.status === 'ready' && <ChartReady data={state.data} />}
    </div>
  )
}

function ChartReady({ data }: { data: ChartData }) {
  const navigate = useNavigate()
  const tree = useMemo(() => buildAccountTree(data.accounts), [data.accounts])
  const rows = useMemo(() => flattenAccountTree(tree), [tree])

  if (data.accounts.length === 0) {
    return (
      <div className="empty-state">
        No accounts yet. Every tenant is seeded with the standard chart at provisioning — this is
        unexpected; contact support if it persists.
      </div>
    )
  }

  return (
    <>
      <Banner tone="info">
        Adding, editing and deactivating accounts is not available yet — the chart is fixed for this
        release. See{' '}
        <a
          href="https://github.com/elitebytesolutions/finsoft/blob/develop/docs/posting-rules/coa-standard.md"
          target="_blank"
          rel="noreferrer"
        >
          coa-standard.md §5
        </a>
        .
      </Banner>
      <Table
        headers={['Account name', 'Code', 'Type', 'Normal', 'Balance (PKR)', 'Status', 'Actions']}
        rows={rows.map(({ account, depth }) =>
          accountRow(account, depth, data.balances.get(account.id), navigate),
        )}
      />
    </>
  )
}

/**
 * The trial balance's own column-follows-sign-of-balance rule
 * (ledger-and-trial-balance.md §3) collapsed into one "Balance" column with an explicit Dr/Cr
 * side — an abnormal balance (a credit on an asset, say) must read as abnormal, never silently
 * as if it were on the account's normal side. Decimal-string equality via `Money.isZero`, never
 * `=== '0.0000'` (ADR-0011: a server-sent scale/representation change must not silently break
 * this check).
 */
function netBalance(
  line: TrialBalanceLine | undefined,
): { amount: string; side: 'Dr' | 'Cr' } | null {
  if (!line) return null
  if (!Money.isZero(Money.from(line.debit))) return { amount: line.debit, side: 'Dr' }
  if (!Money.isZero(Money.from(line.credit))) return { amount: line.credit, side: 'Cr' }
  return null // exact zero — no side to show; rendered as an em dash, same as any nil money cell
}

function accountRow(
  account: AccountDto,
  depth: number,
  balance: TrialBalanceLine | undefined,
  navigate: (path: string) => void,
) {
  const net = netBalance(balance)
  return [
    <span style={{ paddingLeft: (depth - 1) * 20 }}>
      <b>{account.name}</b>
    </span>,
    account.code,
    <Badge tone={account.kind === 'HEADER' ? 'neutral' : 'info'}>
      {account.kind === 'HEADER' ? 'Header' : 'Postable'}
    </Badge>,
    account.normalBalance === 'DEBIT' ? 'Dr' : 'Cr',
    net === null ? '—' : `${moneyFromString(net.amount)} ${net.side}`,
    <Badge tone={account.isActive ? 'good' : 'neutral'}>
      {account.isActive ? 'Active' : 'Inactive'}
    </Badge>,
    account.kind === 'POSTABLE' ? (
      <button
        type="button"
        className="linkable"
        onClick={() => navigate(`/ledgers?account=${encodeURIComponent(account.code)}`)}
      >
        View ledger
      </button>
    ) : (
      ''
    ),
  ]
}
