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
import { RotateCw, ShieldAlert, ChevronRight, Landmark } from 'lucide-react'
import { Banner, Button, PageHead, moneyFromString } from '@finsoft/ui'
import { useNavigate } from '@/lib/router'
import { listAccounts, getTrialBalance } from '@/lib/api/accounting-client'
import { useApiQuery } from '@/lib/api/use-api-query'
import { buildAccountTree, flattenAccountTree } from '@/lib/accounting/account-tree'
import type { AccountDto, TrialBalanceLine } from '@/lib/api/accounting-types'

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

interface ChartData {
  accounts: AccountDto[]
  balances: Map<string, TrialBalanceLine>
}

async function loadChart(): Promise<ChartData> {
  const [accountsRes, trialBalance] = await Promise.all([listAccounts(), getTrialBalance(todayIso())])
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
      <section className="coa2-table density-comfy">
        <div className="coa2-tr head">
          <span className="c-name">Account name</span>
          <span>Code</span>
          <span>Type</span>
          <span>Normal</span>
          <span className="num">Balance (PKR)</span>
          <span>Status</span>
          <span className="c-actions">Actions</span>
        </div>
        {rows.map(({ account, depth }) => (
          <AccountRow
            key={account.id}
            account={account}
            depth={depth}
            balance={data.balances.get(account.id)}
            onViewLedger={() => navigate(`/ledgers?account=${encodeURIComponent(account.code)}`)}
          />
        ))}
      </section>
    </>
  )
}

function netBalance(line: TrialBalanceLine | undefined): string | null {
  if (!line) return null
  // Same column-follows-sign-of-balance rule as the trial balance itself
  // (ledger-and-trial-balance.md §3) — whichever of debit/credit is non-zero is the figure.
  if (line.debit !== '0.0000') return line.debit
  if (line.credit !== '0.0000') return line.credit
  return '0.0000'
}

function AccountRow({
  account,
  depth,
  balance,
  onViewLedger,
}: {
  account: AccountDto
  depth: number
  balance: TrialBalanceLine | undefined
  onViewLedger: () => void
}) {
  const net = netBalance(balance)
  return (
    <div className={`coa2-tr depth-${depth} ${account.kind === 'HEADER' ? 'root' : ''}`}>
      <span className="c-name" style={{ paddingLeft: 10 + (depth - 1) * 24 }}>
        <span className={`coa2-icon ${account.kind === 'HEADER' ? 'green' : 'blue'}`}>
          <Landmark />
        </span>
        <span className="coa2-name">
          <b>{account.name}</b>
        </span>
      </span>
      <span className="c-code">{account.code}</span>
      <span>
        <span className={`coa2-kind ${account.kind.toLowerCase()}`}>
          {account.kind === 'HEADER' ? 'Header' : 'Postable'}
        </span>
      </span>
      <span>{account.normalBalance === 'DEBIT' ? 'Dr' : 'Cr'}</span>
      <span className="num c-balance">{net === null ? '—' : moneyFromString(net, { zeroAsDash: true })}</span>
      <span>
        <span className={`coa2-status ${account.isActive ? 'on' : 'off'}`}>
          ● {account.isActive ? 'Active' : 'Inactive'}
        </span>
      </span>
      <span className="c-actions">
        {account.kind === 'POSTABLE' && (
          <button type="button" className="linkable" onClick={onViewLedger}>
            View ledger <ChevronRight size={12} />
          </button>
        )}
      </span>
    </div>
  )
}
