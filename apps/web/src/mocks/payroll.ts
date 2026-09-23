/* Demo payroll estimation — deliberately quarantined in mocks/.
 *
 * docs/NON_NEGOTIABLES.md rule 14 forbids guessing tax rules and rule 19 puts
 * business logic in the backend domain layer. The Compensation step of the
 * employee wizard shows a payroll preview, so every figure it displays is
 * produced here and nowhere else: when the payroll API lands, this file is
 * replaced and no screen changes.
 *
 * Nothing here has touched a ledger. The payroll run is authoritative; this is
 * an on-screen estimate and is labelled as one.
 */

export type SalaryComponentKind = 'earning' | 'deduction'

export type SalaryComponent = {
  name: string
  kind: SalaryComponentKind
  amount: number
  /** Payroll posting splits on this, which is why the form stores components
   *  rather than one gross figure — docs/design-system/pages/employees §5. */
  taxable: boolean
}

export type PayrollEstimate = {
  earnings: { label: string; amount: number }[]
  gross: number
  deductions: { label: string; amount: number }[]
  totalDeductions: number
  net: number
}

/* PLACEHOLDER SLABS — NOT the FBR schedule.
 *
 * Illustrative monthly bands so the preview shows a plausible shape. The real
 * schedule is versioned, effective-dated and owned by the tax module; it must
 * arrive from the API and be approved by the Accounting Guardian. Do not cite
 * these numbers to anyone and do not copy them into another file. */
const PLACEHOLDER_TAX_BANDS = [
  { upTo: 50_000, rate: 0 },
  { upTo: 100_000, rate: 0.1 },
  { upTo: 150_000, rate: 0.15 },
  { upTo: Infinity, rate: 0.2 },
]

/** Placeholder EOBI contribution. Real EOBI is assessed on minimum wage, not gross. */
const PLACEHOLDER_EOBI_RATE = 0.01

const estimateTax = (taxableMonthly: number) => {
  let remaining = taxableMonthly
  let floor = 0
  let tax = 0
  for (const band of PLACEHOLDER_TAX_BANDS) {
    if (remaining <= 0) break
    const slice = Math.min(remaining, band.upTo - floor)
    tax += slice * band.rate
    remaining -= slice
    floor = band.upTo
  }
  return Math.round(tax)
}

export function estimatePayroll(input: {
  components: SalaryComponent[]
  taxStatus: string
  eobiEnrolled: boolean
}): PayrollEstimate {
  const earnings = input.components.filter((c) => c.kind === 'earning' && c.amount > 0)
  const entered = input.components.filter((c) => c.kind === 'deduction' && c.amount > 0)

  const gross = earnings.reduce((sum, c) => sum + c.amount, 0)
  const taxableBase = earnings.filter((c) => c.taxable).reduce((sum, c) => sum + c.amount, 0)

  const deductions: { label: string; amount: number }[] = []
  if (input.taxStatus === 'Taxable') {
    deductions.push({ label: 'Income Tax (Est.)', amount: estimateTax(taxableBase) })
  }
  if (input.eobiEnrolled) {
    deductions.push({ label: 'EOBI (1%)', amount: Math.round(gross * PLACEHOLDER_EOBI_RATE) })
  }
  for (const c of entered) deductions.push({ label: c.name, amount: Math.round(c.amount) })

  const totalDeductions = deductions.reduce((sum, d) => sum + d.amount, 0)

  return {
    earnings: earnings.map((c) => ({ label: c.name, amount: c.amount })),
    gross,
    deductions,
    totalDeductions,
    net: gross - totalDeductions,
  }
}
