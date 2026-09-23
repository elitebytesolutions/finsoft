'use client'
import { useMemo, useState } from 'react'
import {
  ArrowRight,
  BarChart3,
  Building2,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  Eye,
  FileText,
  Filter,
  LockKeyhole,
  MoreVertical,
  Play,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Upload,
  Users,
  WalletCards,
  X,
} from 'lucide-react'

type PayrollRow = {
  id: string
  name: string
  department: string
  designation: string
  basic: number
  allowances: number
  deductions: number
  net: number
  status: 'Processed' | 'Pending'
}

const numberFromSalary = (value: string) => Number(value.replace(/[^0-9]/g, '')) || 0
const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
const pkr = (value: number) => `PKR ${Math.round(value).toLocaleString()}`

export function PayrollPage({ employees }: { employees: string[][] }) {
  const [month, setMonth] = useState(8)
  const [query, setQuery] = useState('')
  const [department, setDepartment] = useState('All')
  const [status, setStatus] = useState('All')
  const [generated, setGenerated] = useState(false)
  const [locked, setLocked] = useState(false)
  const [preview, setPreview] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ]
  const rows = useMemo<PayrollRow[]>(
    () =>
      employees.map((employee, index) => {
        const basic = numberFromSalary(employee[4]),
          allowances = Math.round(basic * (index % 2 ? 0.14 : 0.16)),
          deductions = Math.round(basic * (index % 3 ? 0.085 : 0.1))
        return {
          id: employee[0],
          name: employee[1],
          department: employee[3],
          designation: employee[2],
          basic,
          allowances,
          deductions,
          net: basic + allowances - deductions,
          status:
            generated || !['Leave', 'Pending'].includes(employee[5]) ? 'Processed' : 'Pending',
        }
      }),
    [employees, generated],
  )
  const departments = [...new Set(rows.map((row) => row.department))]
  const visible = rows.filter(
    (row) =>
      (department === 'All' || row.department === department) &&
      (status === 'All' || row.status === status) &&
      `${row.id} ${row.name} ${row.department} ${row.designation}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  )
  const processed = rows.filter((row) => row.status === 'Processed').length,
    pending = rows.length - processed,
    total = rows.reduce((sum, row) => sum + row.net, 0),
    average = rows.length ? Math.round(total / rows.length) : 0
  const period = `${months[month]} 2026`
  const changeMonth = (direction: number) =>
    setMonth((current) => Math.max(0, Math.min(11, current + direction)))
  const toggleAll = () =>
    setSelected(selected.length === visible.length ? [] : visible.map((row) => row.id))
  const generate = () => {
    setGenerated(true)
    setLocked(false)
  }
  return (
    <div className="payroll-page">
      <section className="payroll-hero">
        <div>
          <span>Payroll Management</span>
          <h1>
            Run payroll with <em>confidence</em>
          </h1>
          <p>
            Manage employee payroll, configurations and generate salary slips — all in one place.
          </p>
        </div>
        <div className="payroll-period">
          <CalendarDays />
          <div>
            <small>Payroll Period</small>
            <b>{period}</b>
          </div>
          <button
            aria-label="Previous payroll period"
            onClick={() => changeMonth(-1)}
            disabled={month === 0}
          >
            <ChevronLeft />
          </button>
          <button
            aria-label="Next payroll period"
            onClick={() => changeMonth(1)}
            disabled={month === 11}
          >
            <ChevronRight />
          </button>
        </div>
        <button className="payroll-btn solid hero" onClick={generate}>
          <Play /> Generate Payroll
        </button>
        <button className="payroll-btn">
          <MoreVertical /> More Actions
        </button>
        <div className="payroll-promise">
          <span>
            <FileText />
            <i>
              <Check />
            </i>
          </span>
          <b>
            Accurate payroll.
            <br />
            Happier people.
          </b>
        </div>
      </section>

      <div className="payroll-kpis">
        <PayrollKpi
          icon={Users}
          label="Total Employees"
          value={String(rows.length)}
          note="2 new this month"
        />
        <PayrollKpi
          icon={WalletCards}
          label="Total Payroll Amount"
          value={pkr(total)}
          note="8% from last month"
          tone="red"
        />
        <PayrollKpi
          icon={ShieldCheck}
          label="Processed"
          value={String(processed)}
          note="Salaries generated"
        />
        <PayrollKpi
          icon={Clock3}
          label="Pending"
          value={String(pending)}
          note="Not yet processed"
          tone="amber"
        />
        <PayrollKpi icon={FileText} label="Issues" value="0" note="No discrepancies" />
      </div>

      <nav className="payroll-tabs" aria-label="Payroll sections">
        {[
          [Users, 'Employee Payroll'],
          [FileText, 'Payroll Runs'],
          [Settings2, 'Configurations'],
          [CircleDollarSign, 'Allowances & Deductions'],
          [Building2, 'Tax Settings'],
          [WalletCards, 'Bank & Payment'],
          [BarChart3, 'Reports'],
          [Send, 'Audit Log'],
        ].map(([Icon, label], index) => {
          const I = Icon as typeof Users
          return (
            <button key={label as string} className={index === 0 ? 'active' : ''}>
              <I />
              {label as string}
            </button>
          )
        })}
      </nav>

      {generated && (
        <div className="payroll-notice">
          <Check /> Payroll for {period} has been generated successfully. Review the amounts before
          locking.
        </div>
      )}

      <div className="payroll-layout">
        <main className="payroll-main">
          <section className="payroll-card employee-payroll">
            <div className="payroll-table-head">
              <div className="payroll-heading">
                <span>
                  <Users />
                </span>
                <div>
                  <h2>Employee Payroll</h2>
                  <p>View and manage employee salaries for the selected period</p>
                </div>
              </div>
              <div className="payroll-filters">
                <label className="payroll-search">
                  <Search />
                  <input
                    aria-label="Search payroll"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search by name, employee ID, department..."
                  />
                </label>
                <label>
                  <span>Department</span>
                  <select
                    aria-label="Department"
                    value={department}
                    onChange={(event) => setDepartment(event.target.value)}
                  >
                    <option>All</option>
                    {departments.map((item) => (
                      <option key={item}>{item}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Status</span>
                  <select
                    aria-label="Payroll status"
                    value={status}
                    onChange={(event) => setStatus(event.target.value)}
                  >
                    <option>All</option>
                    <option>Processed</option>
                    <option>Pending</option>
                  </select>
                </label>
                <button className="payroll-btn">
                  <Filter /> More Filters
                </button>
              </div>
            </div>
            <div className="payroll-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>
                      <input
                        aria-label="Select all payroll rows"
                        type="checkbox"
                        checked={!!visible.length && selected.length === visible.length}
                        onChange={toggleAll}
                      />
                    </th>
                    <th>#</th>
                    <th>Employee</th>
                    <th>Department</th>
                    <th>Designation</th>
                    <th>Basic Salary</th>
                    <th>Allowances</th>
                    <th>Deductions</th>
                    <th>Net Salary</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((row, index) => (
                    <tr key={row.id}>
                      <td>
                        <input
                          aria-label={`Select ${row.name}`}
                          type="checkbox"
                          checked={selected.includes(row.id)}
                          onChange={() =>
                            setSelected((current) =>
                              current.includes(row.id)
                                ? current.filter((id) => id !== row.id)
                                : [...current, row.id],
                            )
                          }
                        />
                      </td>
                      <td>{index + 1}</td>
                      <td>
                        <div className="payroll-person">
                          <span>{initials(row.name)}</span>
                          <div>
                            <b>{row.name}</b>
                            <small>{row.id}</small>
                          </div>
                        </div>
                      </td>
                      <td>{row.department}</td>
                      <td>{row.designation}</td>
                      <td>{pkr(row.basic)}</td>
                      <td>{row.allowances.toLocaleString()}</td>
                      <td>{row.deductions.toLocaleString()}</td>
                      <td>
                        <strong>{row.net.toLocaleString()}</strong>
                      </td>
                      <td>
                        <span className={`payroll-status ${row.status.toLowerCase()}`}>
                          <i />
                          {row.status}
                        </span>
                      </td>
                      <td>
                        <button className="payroll-icon" aria-label={`Actions for ${row.name}`}>
                          <MoreVertical />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {!visible.length && (
                    <tr>
                      <td colSpan={11}>
                        <div className="payroll-empty">No employees match these filters.</div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="payroll-pagination">
              <span>
                Showing {visible.length ? 1 : 0} to {visible.length} of {visible.length} employees
              </span>
              <div>
                <select aria-label="Rows per page">
                  <option>10 per page</option>
                  <option>25 per page</option>
                </select>
                <button disabled>
                  <ChevronLeft />
                </button>
                <button className="active">1</button>
                <button disabled>
                  <ChevronRight />
                </button>
              </div>
            </div>
          </section>
          <div className="payroll-bottom-cards">
            <MiniCard
              icon={CalendarDays}
              label="Last Payroll Run"
              value="31 Aug 2026"
              note={`${rows.length} employees processed`}
            />
            <MiniCard
              icon={CalendarDays}
              label="Next Payroll Due"
              value="30 Sep 2026"
              note="14 days remaining"
            />
            <MiniCard
              icon={FileText}
              label="Total Cost (This Month)"
              value={pkr(total)}
              note="↑ 8% from last month"
            />
            <MiniCard
              icon={BarChart3}
              label="Average Salary"
              value={pkr(average)}
              note="↑ 5% from last month"
            />
          </div>
        </main>

        <aside className="payroll-side">
          <section className="payroll-actions-card">
            <div>
              <Play />
              <span>
                <b>Payroll Actions</b>
                <small>Process payroll and manage employee payments</small>
              </span>
            </div>
            <button onClick={generate}>
              <Play /> Generate Payroll for {period}
            </button>
            <div>
              <button onClick={() => setPreview(true)}>
                <Eye /> Preview Payroll
              </button>
              <button
                className={locked ? 'locked' : ''}
                onClick={() => setLocked((value) => !value)}
              >
                <LockKeyhole /> {locked ? 'Payroll Locked' : 'Lock Payroll'}
              </button>
            </div>
          </section>
          <SideCard
            title="Other Actions"
            items={[
              [Upload, 'Import Attendance'],
              [FileText, 'Import Adjustments'],
              [Settings2, 'Bulk Update'],
              [Send, 'Send Salary Slips'],
              [Check, 'Mark as Paid'],
            ]}
          />
          <SideCard
            title="Payroll Settings"
            icon={Settings2}
            items={[
              [CircleDollarSign, 'Salary Components'],
              [ShieldCheck, 'Tax & Statutory'],
              [Clock3, 'Overtime & Attendance'],
              [FileText, 'Payroll Templates'],
              [WalletCards, 'Bank Payment Settings'],
            ]}
          />
        </aside>
      </div>

      {preview && (
        <div
          className="overlay"
          role="presentation"
          onMouseDown={(event) => event.target === event.currentTarget && setPreview(false)}
        >
          <section
            className="payroll-preview"
            role="dialog"
            aria-modal="true"
            aria-label="Payroll preview"
          >
            <div className="payroll-preview-head">
              <div>
                <small>{period}</small>
                <h2>Payroll Preview</h2>
              </div>
              <button aria-label="Close payroll preview" onClick={() => setPreview(false)}>
                <X />
              </button>
            </div>
            <div className="payroll-preview-total">
              <span>Net payroll</span>
              <b>{pkr(total)}</b>
              <small>
                {rows.length} employees · {processed} processed · {pending} pending
              </small>
            </div>
            <dl>
              <div>
                <dt>Gross salary</dt>
                <dd>{pkr(rows.reduce((sum, row) => sum + row.basic + row.allowances, 0))}</dd>
              </div>
              <div>
                <dt>Total deductions</dt>
                <dd>{pkr(rows.reduce((sum, row) => sum + row.deductions, 0))}</dd>
              </div>
              <div>
                <dt>Selected employees</dt>
                <dd>{selected.length || rows.length}</dd>
              </div>
            </dl>
            <button
              className="payroll-btn solid"
              onClick={() => {
                generate()
                setPreview(false)
              }}
            >
              <Play /> Generate Payroll
            </button>
          </section>
        </div>
      )}
    </div>
  )
}

function PayrollKpi({
  icon: Icon,
  label,
  value,
  note,
  tone = 'green',
}: {
  icon: typeof Users
  label: string
  value: string
  note: string
  tone?: string
}) {
  return (
    <article className="payroll-kpi">
      <span className={tone}>
        <Icon />
      </span>
      <div>
        <b>{value}</b>
        <small>{label}</small>
        <em className={tone}>{note}</em>
      </div>
    </article>
  )
}
function MiniCard({
  icon: Icon,
  label,
  value,
  note,
}: {
  icon: typeof Users
  label: string
  value: string
  note: string
}) {
  return (
    <article className="payroll-mini">
      <span>
        <Icon />
      </span>
      <div>
        <small>{label}</small>
        <b>{value}</b>
        <em>{note}</em>
      </div>
      <ArrowRight />
    </article>
  )
}
function SideCard({
  title,
  icon: Icon,
  items,
}: {
  title: string
  icon?: typeof Users
  items: [typeof Users, string][]
}) {
  return (
    <section className="payroll-side-card">
      <h3>
        {Icon && <Icon />}
        {title}
      </h3>
      {items.map(([ItemIcon, label]) => (
        <button key={label}>
          <span>
            <ItemIcon />
          </span>
          <b>{label}</b>
          <ChevronRight />
        </button>
      ))}
    </section>
  )
}
