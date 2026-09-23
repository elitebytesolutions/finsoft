'use client'
/* Add / edit employee — the six-step record form for /hr.
 *
 * Contract: docs/design-system/pages/employees/README.md §5 (form fields) and §7
 * (financial rules). Two things there shape this file:
 *
 *  - Salary is stored as a component list (name, earning/deduction, amount,
 *    taxable) because payroll posting depends on the split, not on one gross
 *    figure. The five named allowance inputs are presentation; `components` is
 *    the record.
 *  - Nothing here decides a payroll number. The summary rail renders whatever
 *    `estimatePayroll()` returns and nothing else — see apps/web/src/mocks/payroll.ts
 *    for why that boundary exists (NON_NEGOTIABLES rules 14 and 19).
 */
import { Fragment, useMemo, useState, type ReactNode } from 'react'
import { Button, Modal, money } from '@finsoft/ui'
import { estimatePayroll, type SalaryComponent } from '@/mocks/payroll'
import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  Banknote,
  Briefcase,
  Camera,
  Check,
  ChevronLeft,
  CircleCheck,
  ClipboardCheck,
  Contact,
  FileText,
  House,
  IdCard,
  Info,
  Landmark,
  MapPin,
  Paperclip,
  Phone,
  Plus,
  Save,
  ShieldCheck,
  Trash2,
  Upload,
  User,
  Users,
  WalletCards,
  X,
} from 'lucide-react'

/* ------------------------------------------------------------------ model */

const STEPS = [
  'Personal Info',
  'Job & Role',
  'Contact & Address',
  'Compensation',
  'Documents',
  'Review',
] as const

const ALLOWANCES = [
  { key: 'House Allowance', taxable: true },
  { key: 'Transport Allowance', taxable: false },
  { key: 'Medical Allowance', taxable: false },
  { key: 'Commission / Incentive', taxable: true },
  { key: 'Other Allowance', taxable: true },
] as const

const REQUIRED_DOCS = [
  'Profile Photo',
  'CNIC / National ID (Front)',
  'CNIC / National ID (Back)',
  'Resume / CV',
] as const

const OPTIONAL_DOCS = [
  'Offer Letter',
  'Employment Contract',
  'Educational Certificates',
  'Experience Letters',
  'Bank Account Proof',
  'Tax Documents',
  'Additional Attachments',
] as const

type DocKey = (typeof REQUIRED_DOCS)[number] | (typeof OPTIONAL_DOCS)[number]

type DocFile = { name: string; size: number }

type Draft = {
  firstName: string
  lastName: string
  employeeId: string
  dob: string
  gender: string
  maritalStatus: string
  cnic: string
  nationality: string
  personalEmail: string
  companyEmail: string
  mobile: string
  altPhone: string
  emergencyName: string
  emergencyNumber: string

  joiningDate: string
  department: string
  designation: string
  employmentType: string
  category: string
  reportingManager: string
  branch: string
  workLocation: string
  shift: string
  probation: string
  team: string
  salesTarget: boolean
  attendancePolicy: string
  accessRole: string
  notes: string

  addr1: string
  addr2: string
  city: string
  area: string
  province: string
  postal: string
  country: string
  residence: string
  landmark: string
  locationNotes: string
  sameAsPresent: boolean
  pAddr1: string
  pAddr2: string
  pCity: string
  pArea: string
  pProvince: string
  pPostal: string
  pCountry: string
  pResidence: string
  preferredContact: string
  language: string
  notifyWork: boolean
  notifyPayroll: boolean
  notifyMarketing: boolean
  kinName: string
  kinRelationship: string
  kinNumber: string
  kinAltNumber: string

  grossSalary: number
  basicPct: number
  components: SalaryComponent[]
  payrollCycle: string
  overtime: boolean
  taxStatus: string
  eobi: boolean
  costCentre: string
  paymentMode: string
  bankName: string
  accountTitle: string
  iban: string
  salaryRemarks: string

  docs: Partial<Record<DocKey, DocFile[]>>
  confirmed: boolean
}

const nextEmployeeId = (list: string[][]) => {
  const n =
    Math.max(0, ...list.map((r) => parseInt(String(r[0]).split('-')[1] || '0', 10) || 0)) + 1
  return `BT-${String(n).padStart(3, '0')}`
}

const emptyDraft = (list: string[][]): Draft => ({
  firstName: '',
  lastName: '',
  employeeId: nextEmployeeId(list),
  dob: '',
  gender: '',
  maritalStatus: '',
  cnic: '',
  nationality: 'Pakistani',
  personalEmail: '',
  companyEmail: '',
  mobile: '',
  altPhone: '',
  emergencyName: '',
  emergencyNumber: '',

  joiningDate: '',
  department: 'Sales',
  designation: 'Sales Executive',
  employmentType: 'Full Time',
  category: 'Permanent',
  reportingManager: '',
  branch: 'Lahore',
  workLocation: 'Office (On-site)',
  shift: 'General Shift (9 AM - 6 PM)',
  probation: '3 Months',
  team: '',
  salesTarget: true,
  attendancePolicy: 'Standard (Office Hours)',
  accessRole: 'Sales User',
  notes: '',

  addr1: '',
  addr2: '',
  city: '',
  area: '',
  province: 'Punjab',
  postal: '',
  country: 'Pakistan',
  residence: 'Owned House',
  landmark: '',
  locationNotes: '',
  sameAsPresent: true,
  pAddr1: '',
  pAddr2: '',
  pCity: '',
  pArea: '',
  pProvince: 'Punjab',
  pPostal: '',
  pCountry: 'Pakistan',
  pResidence: 'Owned House',
  preferredContact: 'Mobile Phone',
  language: 'English',
  notifyWork: true,
  notifyPayroll: false,
  notifyMarketing: false,
  kinName: '',
  kinRelationship: '',
  kinNumber: '',
  kinAltNumber: '',

  grossSalary: 0,
  basicPct: 60,
  components: ALLOWANCES.map((a) => ({
    name: a.key,
    kind: 'earning' as const,
    amount: 0,
    taxable: a.taxable,
  })),
  payrollCycle: 'Monthly',
  overtime: true,
  taxStatus: 'Taxable',
  eobi: true,
  costCentre: 'Sales & Marketing',
  paymentMode: 'Bank Transfer',
  bankName: '',
  accountTitle: '',
  iban: '',
  salaryRemarks: '',

  docs: {},
  confirmed: false,
})

/* Basic pay is a split of the entered gross, set by the percentage field. It is
 * a data-entry affordance, not a derived financial figure: it becomes a stored
 * component like every other line, and payroll reads the components. */
const basicAmount = (d: Draft) => Math.round((d.grossSalary * d.basicPct) / 100)

const allComponents = (d: Draft): SalaryComponent[] => [
  { name: 'Basic Salary', kind: 'earning', amount: basicAmount(d), taxable: true },
  ...d.components,
]

/* --------------------------------------------------------------- validation */

type Errors = Partial<Record<keyof Draft | 'docs', string>>

const required = (d: Draft, keys: (keyof Draft)[], errors: Errors) => {
  for (const k of keys) {
    const v = d[k]
    if (v === '' || v === undefined || v === null) errors[k] = 'Required'
  }
}

const validateStep = (step: number, d: Draft): Errors => {
  const e: Errors = {}
  if (step === 0) {
    required(
      d,
      [
        'firstName',
        'lastName',
        'employeeId',
        'dob',
        'gender',
        'maritalStatus',
        'cnic',
        'nationality',
        'personalEmail',
        'mobile',
        'emergencyName',
        'emergencyNumber',
      ],
      e,
    )
    if (d.cnic && !/^\d{5}-\d{7}-\d$/.test(d.cnic)) e.cnic = 'Use the format 35202-1234567-1'
    if (d.personalEmail && !/^\S+@\S+\.\S+$/.test(d.personalEmail))
      e.personalEmail = 'Enter a valid email address'
    if (d.companyEmail && !/^\S+@\S+\.\S+$/.test(d.companyEmail))
      e.companyEmail = 'Enter a valid email address'
  }
  if (step === 1) {
    required(
      d,
      [
        'joiningDate',
        'department',
        'designation',
        'employmentType',
        'category',
        'reportingManager',
        'branch',
        'workLocation',
        'shift',
        'attendancePolicy',
        'accessRole',
      ],
      e,
    )
  }
  if (step === 2) {
    required(d, ['addr1', 'city', 'area', 'province', 'postal', 'country', 'residence'], e)
    required(d, ['preferredContact', 'kinName', 'kinRelationship', 'kinNumber'], e)
    if (!d.sameAsPresent) required(d, ['pAddr1', 'pCity', 'pArea', 'pPostal'], e)
  }
  if (step === 3) {
    if (!d.grossSalary || d.grossSalary <= 0) e.grossSalary = 'Enter the gross monthly salary'
    required(d, ['payrollCycle', 'taxStatus', 'costCentre', 'paymentMode'], e)
    if (d.paymentMode === 'Bank Transfer') required(d, ['bankName', 'accountTitle', 'iban'], e)
  }
  if (step === 4) {
    const missing = REQUIRED_DOCS.filter((k) => !(d.docs[k]?.length ?? 0))
    if (missing.length) e.docs = `${missing.length} required document(s) still to upload`
  }
  if (step === 5 && !d.confirmed) e.confirmed = 'Confirm the information before creating'
  return e
}

/* ------------------------------------------------------------------ fields */

/* The grid cell is a div, not a label: `footer` carries controls that need their
 * own label (the taxable checkbox), and a label nested inside a label is invalid
 * HTML — it breaks the click target and inherits the column layout. */
function Field({
  label,
  req,
  hint,
  error,
  children,
  full,
  footer,
}: {
  label: string
  req?: boolean
  hint?: string
  error?: string
  children: ReactNode
  full?: boolean
  footer?: ReactNode
}) {
  return (
    <div className={`ew-field${full ? ' full' : ''}`}>
      <label className="ew-field-main">
        <span className="ew-label">
          {label}
          {req && (
            <span className="req" aria-hidden="true">
              *
            </span>
          )}
        </span>
        {children}
        {error ? (
          <span className="ew-error" role="alert">
            {error}
          </span>
        ) : hint ? (
          <span className="ew-hint">{hint}</span>
        ) : null}
      </label>
      {footer}
    </div>
  )
}

function Select({
  value,
  onChange,
  options,
  placeholder,
  invalid,
}: {
  value: string
  onChange: (v: string) => void
  options: readonly string[]
  placeholder?: string
  invalid?: boolean
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-invalid={invalid || undefined}
    >
      {placeholder && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={o}>{o}</option>
      ))}
    </select>
  )
}

function Card({
  icon,
  title,
  sub,
  children,
  aside,
}: {
  icon: ReactNode
  title: string
  sub: string
  children: ReactNode
  aside?: ReactNode
}) {
  return (
    <section className="ew-card">
      <div className="ew-card-head">
        <span className="ew-card-icon" aria-hidden="true">
          {icon}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3>{title}</h3>
          <p>{sub}</p>
        </div>
        {aside}
      </div>
      {children}
    </section>
  )
}

/* ------------------------------------------------------------------- steps */

function PersonalStep({ d, set, e }: { d: Draft; set: (p: Partial<Draft>) => void; e: Errors }) {
  return (
    <>
      <Card
        icon={<User />}
        title="Personal Information"
        sub="Let's start with the basic details about the employee."
      >
        <div className="ew-fields">
          <Field label="First Name" req error={e.firstName}>
            <input
              value={d.firstName}
              onChange={(ev) => set({ firstName: ev.target.value })}
              placeholder="Enter first name"
              aria-invalid={!!e.firstName || undefined}
              autoFocus
            />
          </Field>
          <Field label="Last Name" req error={e.lastName}>
            <input
              value={d.lastName}
              onChange={(ev) => set({ lastName: ev.target.value })}
              placeholder="Enter last name"
              aria-invalid={!!e.lastName || undefined}
            />
          </Field>
          <Field label="Employee ID" req hint="Auto-generated. You can regenerate if needed.">
            <div className="ew-prefixed">
              <span className="ew-prefix">
                <IdCard size={13} />
              </span>
              <input value={d.employeeId} onChange={(ev) => set({ employeeId: ev.target.value })} />
            </div>
          </Field>
          <Field label="Date of Birth" req error={e.dob}>
            <input
              type="date"
              value={d.dob}
              onChange={(ev) => set({ dob: ev.target.value })}
              aria-invalid={!!e.dob || undefined}
            />
          </Field>
          <Field label="Gender" req error={e.gender}>
            <Select
              value={d.gender}
              onChange={(v) => set({ gender: v })}
              options={['Male', 'Female', 'Other']}
              placeholder="Select gender"
              invalid={!!e.gender}
            />
          </Field>
          <Field label="Marital Status" req error={e.maritalStatus}>
            <Select
              value={d.maritalStatus}
              onChange={(v) => set({ maritalStatus: v })}
              options={['Single', 'Married', 'Divorced', 'Widowed']}
              placeholder="Select marital status"
              invalid={!!e.maritalStatus}
            />
          </Field>
          <Field label="CNIC / National ID" req hint="e.g. 35202-1234567-1" error={e.cnic}>
            <input
              value={d.cnic}
              onChange={(ev) => set({ cnic: ev.target.value })}
              placeholder="Enter CNIC number"
              inputMode="numeric"
              aria-invalid={!!e.cnic || undefined}
            />
          </Field>
          <Field label="Nationality" req error={e.nationality}>
            <Select
              value={d.nationality}
              onChange={(v) => set({ nationality: v })}
              options={['Pakistani', 'Other']}
              invalid={!!e.nationality}
            />
          </Field>
        </div>
      </Card>

      <Card
        icon={<Phone />}
        title="Contact Information"
        sub="Add email addresses and phone numbers for communication."
      >
        <div className="ew-fields">
          <Field
            label="Personal Email"
            req
            hint="Used for personal communication"
            error={e.personalEmail}
          >
            <input
              type="email"
              value={d.personalEmail}
              onChange={(ev) => set({ personalEmail: ev.target.value })}
              placeholder="Enter personal email"
              aria-invalid={!!e.personalEmail || undefined}
            />
          </Field>
          <Field
            label="Company Email"
            hint="Will be used for official communication"
            error={e.companyEmail}
          >
            <input
              type="email"
              value={d.companyEmail}
              onChange={(ev) => set({ companyEmail: ev.target.value })}
              placeholder="Enter company email (optional)"
              aria-invalid={!!e.companyEmail || undefined}
            />
          </Field>
          <Field label="Mobile Number" req error={e.mobile}>
            <div className="ew-prefixed">
              <span className="ew-prefix">+92</span>
              <input
                value={d.mobile}
                onChange={(ev) => set({ mobile: ev.target.value })}
                placeholder="Enter mobile number"
                inputMode="tel"
                aria-invalid={!!e.mobile || undefined}
              />
            </div>
          </Field>
          <Field label="Alternate Phone">
            <div className="ew-prefixed">
              <span className="ew-prefix">+92</span>
              <input
                value={d.altPhone}
                onChange={(ev) => set({ altPhone: ev.target.value })}
                placeholder="Enter alternate number (optional)"
                inputMode="tel"
              />
            </div>
          </Field>
          <Field label="Emergency Contact Name" req error={e.emergencyName}>
            <input
              value={d.emergencyName}
              onChange={(ev) => set({ emergencyName: ev.target.value })}
              placeholder="Enter emergency contact name"
              aria-invalid={!!e.emergencyName || undefined}
            />
          </Field>
          <Field label="Emergency Contact Number" req error={e.emergencyNumber}>
            <div className="ew-prefixed">
              <span className="ew-prefix">+92</span>
              <input
                value={d.emergencyNumber}
                onChange={(ev) => set({ emergencyNumber: ev.target.value })}
                placeholder="Enter emergency number"
                inputMode="tel"
                aria-invalid={!!e.emergencyNumber || undefined}
              />
            </div>
          </Field>
        </div>
      </Card>
    </>
  )
}

const ROLE_CAPABILITIES: Record<string, { can: string[]; cannot: string[] }> = {
  'Sales User': {
    can: [
      'View customers and contacts',
      'Create and manage sales orders',
      'Access sales reports and dashboards',
      'Manage assigned leads',
      'Update customer information',
      'View inventory (read-only)',
    ],
    cannot: [
      'Cannot manage system settings',
      'Cannot access payroll data',
      'Cannot approve expenses',
      'Limited to assigned branch data',
    ],
  },
  'Accounts User': {
    can: [
      'Enter vouchers and receipts',
      'View customer and vendor ledgers',
      'Run financial reports',
      'Reconcile bank statements',
    ],
    cannot: [
      'Cannot post to closed periods',
      'Cannot manage users or roles',
      'Cannot approve its own vouchers',
      'Cannot reverse posted entries',
    ],
  },
  'Store User': {
    can: [
      'Record goods received',
      'Issue stock against orders',
      'Run physical counts',
      'View product catalogue',
    ],
    cannot: [
      'Cannot change product costs',
      'Cannot access payroll data',
      'Cannot approve adjustments',
      'Limited to assigned warehouse',
    ],
  },
  Administrator: {
    can: [
      'Manage users, roles and permissions',
      'Configure system settings',
      'Access every module',
      'View the audit trail',
    ],
    cannot: [
      'Cannot post financial transactions without the posting permission',
      'Cannot edit a posted record',
      'Cannot modify audit history',
      'Cannot reopen a locked period',
    ],
  },
}

function JobStep({ d, set, e }: { d: Draft; set: (p: Partial<Draft>) => void; e: Errors }) {
  const caps = ROLE_CAPABILITIES[d.accessRole] ?? ROLE_CAPABILITIES['Sales User']
  const initials = `${d.firstName[0] ?? ''}${d.lastName[0] ?? ''}`.toUpperCase() || 'EMP'
  return (
    <div className="ew-body">
      <div>
        <Card
          icon={<Briefcase />}
          title="Job & Role Details"
          sub="Define the employee's role, department and working details."
        >
          <div className="ew-fields">
            <Field
              label="Joining Date"
              req
              hint="Employee's official joining date."
              error={e.joiningDate}
            >
              <input
                type="date"
                value={d.joiningDate}
                onChange={(ev) => set({ joiningDate: ev.target.value })}
                aria-invalid={!!e.joiningDate || undefined}
              />
            </Field>
            <Field label="Department" req hint="Select the primary department.">
              <Select
                value={d.department}
                onChange={(v) => set({ department: v })}
                options={[
                  'Sales',
                  'Operations',
                  'Accounts',
                  'Store',
                  'Administration',
                  'Logistics',
                ]}
              />
            </Field>
            <Field label="Designation" req hint="Job title or designation.">
              <Select
                value={d.designation}
                onChange={(v) => set({ designation: v })}
                options={[
                  'Branch Manager',
                  'Sales Executive',
                  'Pharmacist',
                  'Accounts Officer',
                  'Store Keeper',
                  'Delivery Supervisor',
                  'Purchase Officer',
                  'Assistant',
                ]}
              />
            </Field>
            <Field label="Employment Type" req hint="Type of employment contract.">
              <Select
                value={d.employmentType}
                onChange={(v) => set({ employmentType: v })}
                options={['Full Time', 'Part Time', 'Contract', 'Internship', 'Daily Wage']}
              />
            </Field>
            <Field label="Employee Category" req hint="Employee classification.">
              <Select
                value={d.category}
                onChange={(v) => set({ category: v })}
                options={['Permanent', 'Probation', 'Temporary', 'Consultant']}
              />
            </Field>
            <Field
              label="Reporting Manager"
              req
              hint="Select the direct manager."
              error={e.reportingManager}
            >
              <Select
                value={d.reportingManager}
                onChange={(v) => set({ reportingManager: v })}
                options={['Ahmed Raza', 'Hira Ali', 'Kashif Ali', 'Regional Manager']}
                placeholder="Select manager"
                invalid={!!e.reportingManager}
              />
            </Field>
            <Field label="Branch" req hint="Workplace branch.">
              <Select
                value={d.branch}
                onChange={(v) => set({ branch: v })}
                options={['Lahore', 'Rawalpindi', 'Faisalabad', 'Karachi']}
              />
            </Field>
            <Field label="Work Location" req hint="Primary work location.">
              <Select
                value={d.workLocation}
                onChange={(v) => set({ workLocation: v })}
                options={['Office (On-site)', 'Field', 'Warehouse', 'Remote', 'Hybrid']}
              />
            </Field>
            <Field label="Shift" req hint="Assigned working shift.">
              <Select
                value={d.shift}
                onChange={(v) => set({ shift: v })}
                options={[
                  'General Shift (9 AM - 6 PM)',
                  'Morning Shift (7 AM - 3 PM)',
                  'Evening Shift (2 PM - 10 PM)',
                  'Flexible',
                ]}
              />
            </Field>
            <Field label="Probation Period" hint="Initial probation period.">
              <Select
                value={d.probation}
                onChange={(v) => set({ probation: v })}
                options={['None', '1 Month', '3 Months', '6 Months']}
              />
            </Field>
            <Field label="Team" hint="Assign to a team (optional).">
              <Select
                value={d.team}
                onChange={(v) => set({ team: v })}
                options={['Field Sales Team', 'Counter Team', 'Distribution Team']}
                placeholder="Select team"
              />
            </Field>
            <Field label="Sales Target Eligibility" hint="Include in sales target and incentives.">
              <span className="ew-switch">
                <input
                  type="checkbox"
                  checked={d.salesTarget}
                  onChange={(ev) => set({ salesTarget: ev.target.checked })}
                  aria-label="Eligible for sales targets"
                />
                Eligible for sales targets
              </span>
            </Field>
            <Field label="Attendance Policy" req hint="Applicable attendance policy.">
              <Select
                value={d.attendancePolicy}
                onChange={(v) => set({ attendancePolicy: v })}
                options={['Standard (Office Hours)', 'Field Staff', 'Shift Based', 'Flexible']}
              />
            </Field>
            <Field label="Access Role" req hint="System access role.">
              <Select
                value={d.accessRole}
                onChange={(v) => set({ accessRole: v })}
                options={Object.keys(ROLE_CAPABILITIES)}
              />
            </Field>
            <Field label="Additional Notes" full>
              <textarea
                value={d.notes}
                onChange={(ev) => set({ notes: ev.target.value.slice(0, 500) })}
                placeholder="Enter any additional notes (optional)..."
              />
              <span className="ew-hint">{d.notes.length}/500</span>
            </Field>
          </div>
        </Card>
      </div>

      <aside className="ew-rail">
        <div className="ew-rail-card">
          <div className="ew-rail-head">
            <ShieldCheck />
            <div>
              <h4>Role &amp; Access Preview</h4>
              <p>Overview of the selected role capabilities.</p>
            </div>
          </div>
          <div className="ew-rail-head">
            <span className="ew-card-icon" aria-hidden="true">
              {initials}
            </span>
            <div>
              <h4>{d.accessRole}</h4>
              <p>
                {d.designation} · {d.department}
              </p>
            </div>
          </div>
          <p className="ew-list-title">Key Capabilities</p>
          <ul className="ew-list">
            {caps.can.map((c) => (
              <li key={c}>
                <CircleCheck className="ok" aria-hidden="true" />
                {c}
              </li>
            ))}
          </ul>
          <p className="ew-list-title">Restrictions</p>
          <ul className="ew-list">
            {caps.cannot.map((c) => (
              <li key={c}>
                <X className="no" aria-hidden="true" />
                {c}
              </li>
            ))}
          </ul>
          <div className="ew-estimate-note">
            <Info aria-hidden="true" />
            <span>
              Roles are a collection of atomic permissions and are enforced server-side. This
              preview is informational.
            </span>
          </div>
        </div>
      </aside>
    </div>
  )
}

const PROVINCES = [
  'Punjab',
  'Sindh',
  'Khyber Pakhtunkhwa',
  'Balochistan',
  'Islamabad Capital Territory',
]
const RESIDENCE = ['Owned House', 'Rented House', 'Family House', 'Company Accommodation']

function AddressStep({ d, set, e }: { d: Draft; set: (p: Partial<Draft>) => void; e: Errors }) {
  return (
    <>
      <Card
        icon={<MapPin />}
        title="Present Address"
        sub="Enter the employee's current residential address."
      >
        <div className="ew-fields">
          <Field label="Address Line 1" req error={e.addr1}>
            <input
              value={d.addr1}
              onChange={(ev) => set({ addr1: ev.target.value })}
              placeholder="House No. 245, Street 12"
              aria-invalid={!!e.addr1 || undefined}
            />
          </Field>
          <Field label="Address Line 2">
            <input
              value={d.addr2}
              onChange={(ev) => set({ addr2: ev.target.value })}
              placeholder="Apartment, Floor, Block, etc."
            />
          </Field>
          <Field label="City" req error={e.city}>
            <input
              value={d.city}
              onChange={(ev) => set({ city: ev.target.value })}
              placeholder="Lahore"
              aria-invalid={!!e.city || undefined}
            />
          </Field>
          <Field label="Area / Locality" req error={e.area}>
            <input
              value={d.area}
              onChange={(ev) => set({ area: ev.target.value })}
              placeholder="DHA Phase 5"
              aria-invalid={!!e.area || undefined}
            />
          </Field>
          <Field label="State / Province" req>
            <Select value={d.province} onChange={(v) => set({ province: v })} options={PROVINCES} />
          </Field>
          <Field label="Postal Code" req error={e.postal}>
            <input
              value={d.postal}
              onChange={(ev) => set({ postal: ev.target.value })}
              placeholder="54000"
              inputMode="numeric"
              aria-invalid={!!e.postal || undefined}
            />
          </Field>
          <Field label="Country" req>
            <Select
              value={d.country}
              onChange={(v) => set({ country: v })}
              options={['Pakistan']}
            />
          </Field>
          <Field label="Residence Type" req>
            <Select
              value={d.residence}
              onChange={(v) => set({ residence: v })}
              options={RESIDENCE}
            />
          </Field>
          <Field label="Landmark">
            <input
              value={d.landmark}
              onChange={(ev) => set({ landmark: ev.target.value })}
              placeholder="Near Lahore Grammar School"
            />
          </Field>
          <Field label="Emergency Location Notes" full>
            <input
              value={d.locationNotes}
              onChange={(ev) => set({ locationNotes: ev.target.value })}
              placeholder="Blue gate, second house on left side"
            />
          </Field>
        </div>
      </Card>

      <Card
        icon={<House />}
        title="Permanent Address"
        sub="Enter the employee's permanent (home town) address."
        aside={
          <span className="ew-switch">
            <input
              type="checkbox"
              checked={d.sameAsPresent}
              onChange={(ev) => set({ sameAsPresent: ev.target.checked })}
              aria-label="Permanent address is the same as present address"
            />
            Same as present address
          </span>
        }
      >
        <div className="ew-fields">
          <Field label="Address Line 1" req={!d.sameAsPresent} error={e.pAddr1}>
            <input
              value={d.sameAsPresent ? d.addr1 : d.pAddr1}
              onChange={(ev) => set({ pAddr1: ev.target.value })}
              placeholder="House No. 245, Street 12"
              disabled={d.sameAsPresent}
              aria-invalid={!!e.pAddr1 || undefined}
            />
          </Field>
          <Field label="Address Line 2">
            <input
              value={d.sameAsPresent ? d.addr2 : d.pAddr2}
              onChange={(ev) => set({ pAddr2: ev.target.value })}
              placeholder="Apartment, Floor, Block, etc."
              disabled={d.sameAsPresent}
            />
          </Field>
          <Field label="City" req={!d.sameAsPresent} error={e.pCity}>
            <input
              value={d.sameAsPresent ? d.city : d.pCity}
              onChange={(ev) => set({ pCity: ev.target.value })}
              disabled={d.sameAsPresent}
              aria-invalid={!!e.pCity || undefined}
            />
          </Field>
          <Field label="Area / Locality" req={!d.sameAsPresent} error={e.pArea}>
            <input
              value={d.sameAsPresent ? d.area : d.pArea}
              onChange={(ev) => set({ pArea: ev.target.value })}
              disabled={d.sameAsPresent}
              aria-invalid={!!e.pArea || undefined}
            />
          </Field>
          <Field label="State / Province">
            <Select
              value={d.sameAsPresent ? d.province : d.pProvince}
              onChange={(v) => set({ pProvince: v })}
              options={PROVINCES}
            />
          </Field>
          <Field label="Postal Code" req={!d.sameAsPresent} error={e.pPostal}>
            <input
              value={d.sameAsPresent ? d.postal : d.pPostal}
              onChange={(ev) => set({ pPostal: ev.target.value })}
              disabled={d.sameAsPresent}
              inputMode="numeric"
              aria-invalid={!!e.pPostal || undefined}
            />
          </Field>
          <Field label="Country">
            <Select
              value={d.sameAsPresent ? d.country : d.pCountry}
              onChange={(v) => set({ pCountry: v })}
              options={['Pakistan']}
            />
          </Field>
          <Field label="Residence Type">
            <Select
              value={d.sameAsPresent ? d.residence : d.pResidence}
              onChange={(v) => set({ pResidence: v })}
              options={RESIDENCE}
            />
          </Field>
        </div>
      </Card>

      <div className="ew-body">
        <Card
          icon={<Phone />}
          title="Communication Preferences"
          sub="Choose how you'd like to communicate with this employee."
        >
          <div className="ew-fields cols-2">
            <Field label="Preferred Contact Method" req error={e.preferredContact}>
              <Select
                value={d.preferredContact}
                onChange={(v) => set({ preferredContact: v })}
                options={['Mobile Phone', 'Email', 'WhatsApp', 'SMS']}
                invalid={!!e.preferredContact}
              />
            </Field>
            <Field label="Language Preference">
              <Select
                value={d.language}
                onChange={(v) => set({ language: v })}
                options={['English', 'Urdu']}
              />
            </Field>
          </div>
          <div className="ew-checks">
            <label className="ew-check">
              <input
                type="checkbox"
                checked={d.notifyWork}
                onChange={(ev) => set({ notifyWork: ev.target.checked })}
              />
              Send work-related notifications (email, SMS)
            </label>
            <label className="ew-check">
              <input
                type="checkbox"
                checked={d.notifyPayroll}
                onChange={(ev) => set({ notifyPayroll: ev.target.checked })}
              />
              Send payroll and HR updates
            </label>
            <label className="ew-check">
              <input
                type="checkbox"
                checked={d.notifyMarketing}
                onChange={(ev) => set({ notifyMarketing: ev.target.checked })}
              />
              Send marketing and product updates
            </label>
          </div>
        </Card>

        <Card
          icon={<Users />}
          title="Emergency Contact"
          sub="Person to be contacted in case of an emergency."
        >
          <div className="ew-fields cols-2">
            <Field label="Contact Name" req error={e.kinName}>
              <input
                value={d.kinName}
                onChange={(ev) => set({ kinName: ev.target.value })}
                placeholder="Muhammad Ali"
                aria-invalid={!!e.kinName || undefined}
              />
            </Field>
            <Field label="Relationship" req error={e.kinRelationship}>
              <Select
                value={d.kinRelationship}
                onChange={(v) => set({ kinRelationship: v })}
                options={[
                  'Father',
                  'Mother',
                  'Brother',
                  'Sister',
                  'Spouse',
                  'Son',
                  'Daughter',
                  'Other',
                ]}
                placeholder="Select relationship"
                invalid={!!e.kinRelationship}
              />
            </Field>
            <Field label="Contact Number" req error={e.kinNumber}>
              <div className="ew-prefixed">
                <span className="ew-prefix">+92</span>
                <input
                  value={d.kinNumber}
                  onChange={(ev) => set({ kinNumber: ev.target.value })}
                  placeholder="321 7654321"
                  inputMode="tel"
                  aria-invalid={!!e.kinNumber || undefined}
                />
              </div>
            </Field>
            <Field label="Alternate Number">
              <div className="ew-prefixed">
                <span className="ew-prefix">+92</span>
                <input
                  value={d.kinAltNumber}
                  onChange={(ev) => set({ kinAltNumber: ev.target.value })}
                  placeholder="300 1122334"
                  inputMode="tel"
                />
              </div>
            </Field>
          </div>
        </Card>
      </div>
    </>
  )
}

function CompensationStep({
  d,
  set,
  e,
  estimate,
}: {
  d: Draft
  set: (p: Partial<Draft>) => void
  e: Errors
  estimate: ReturnType<typeof estimatePayroll>
}) {
  const setComponent = (name: string, patch: Partial<SalaryComponent>) =>
    set({ components: d.components.map((c) => (c.name === name ? { ...c, ...patch } : c)) })

  const named = new Set<string>(ALLOWANCES.map((a) => a.key))
  const custom = d.components.filter((c) => !named.has(c.name))
  const mismatch = d.grossSalary > 0 && estimate.gross !== d.grossSalary

  return (
    <div className="ew-body">
      <div>
        <Card
          icon={<Banknote />}
          title="Salary Structure"
          sub="Define the employee's salary details and allowance structure."
        >
          <div className="ew-fields">
            <Field
              label="Gross Salary (PKR)"
              req
              hint="Total monthly gross salary."
              error={e.grossSalary}
            >
              <div className="ew-prefixed ew-money">
                <span className="ew-prefix">Rs</span>
                <input
                  type="number"
                  min={0}
                  value={d.grossSalary || ''}
                  onChange={(ev) => set({ grossSalary: Number(ev.target.value) || 0 })}
                  aria-invalid={!!e.grossSalary || undefined}
                />
              </div>
            </Field>
            <Field label="Basic Salary (%)" hint="Percentage of gross salary.">
              <div className="ew-suffixed ew-money">
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={d.basicPct}
                  onChange={(ev) =>
                    set({ basicPct: Math.min(100, Math.max(0, Number(ev.target.value) || 0)) })
                  }
                />
                <span className="ew-suffix">%</span>
              </div>
            </Field>
            <Field label="Basic Salary (PKR)" hint="Split of gross, from the percentage.">
              <div className="ew-prefixed ew-money">
                <span className="ew-prefix">Rs</span>
                <input value={basicAmount(d).toLocaleString('en-PK')} readOnly tabIndex={-1} />
              </div>
            </Field>
            {ALLOWANCES.map((a) => {
              const c = d.components.find((x) => x.name === a.key)!
              return (
                <Field
                  key={a.key}
                  label={`${a.key} (PKR)`}
                  footer={
                    <label className="ew-check">
                      <input
                        type="checkbox"
                        checked={c.taxable}
                        onChange={(ev) => setComponent(a.key, { taxable: ev.target.checked })}
                      />
                      Taxable
                    </label>
                  }
                >
                  <div className="ew-prefixed ew-money">
                    <span className="ew-prefix">Rs</span>
                    <input
                      type="number"
                      min={0}
                      value={c.amount || ''}
                      onChange={(ev) =>
                        setComponent(a.key, { amount: Number(ev.target.value) || 0 })
                      }
                    />
                  </div>
                </Field>
              )
            })}
          </div>

          {/* The record is the component list, not the five inputs above — payroll
              posting splits on it (docs/design-system/pages/employees §5). */}
          <div className="ew-components">
            <div className="ew-components-head">
              <p>Other salary components</p>
              <Button
                kind="secondary"
                onClick={() =>
                  set({
                    components: [
                      ...d.components,
                      { name: '', kind: 'earning', amount: 0, taxable: true },
                    ],
                  })
                }
              >
                <Plus /> Add component
              </Button>
            </div>
            {custom.length === 0 && (
              <p className="ew-hint">
                Nothing beyond the named allowances. Add a component for anything payroll must treat
                separately — a deduction, a stipend, an arrears line.
              </p>
            )}
            {custom.map((c, i) => (
              <div className="ew-component-row" key={`custom-${i}`}>
                <input
                  value={c.name}
                  placeholder="Component name"
                  onChange={(ev) =>
                    set({
                      components: d.components.map((x) =>
                        x === c ? { ...x, name: ev.target.value } : x,
                      ),
                    })
                  }
                  aria-label="Component name"
                />
                <select
                  value={c.kind}
                  onChange={(ev) =>
                    set({
                      components: d.components.map((x) =>
                        x === c ? { ...x, kind: ev.target.value as SalaryComponent['kind'] } : x,
                      ),
                    })
                  }
                  aria-label="Component type"
                >
                  <option value="earning">Earning</option>
                  <option value="deduction">Deduction</option>
                </select>
                <input
                  type="number"
                  min={0}
                  value={c.amount || ''}
                  placeholder="0"
                  onChange={(ev) =>
                    set({
                      components: d.components.map((x) =>
                        x === c ? { ...x, amount: Number(ev.target.value) || 0 } : x,
                      ),
                    })
                  }
                  aria-label="Component amount"
                />
                <label className="ew-check">
                  <input
                    type="checkbox"
                    checked={c.taxable}
                    onChange={(ev) =>
                      set({
                        components: d.components.map((x) =>
                          x === c ? { ...x, taxable: ev.target.checked } : x,
                        ),
                      })
                    }
                  />
                  Taxable
                </label>
                <button
                  className="icon-btn"
                  aria-label={`Remove ${c.name || 'component'}`}
                  onClick={() => set({ components: d.components.filter((x) => x !== c) })}
                >
                  <Trash2 />
                </button>
              </div>
            ))}
          </div>
        </Card>

        <Card
          icon={<ClipboardCheck />}
          title="Payroll Settings"
          sub="Configure payroll cycle, tax and statutory benefits."
        >
          <div className="ew-fields">
            <Field label="Payroll Cycle" req hint="Salary payment frequency.">
              <Select
                value={d.payrollCycle}
                onChange={(v) => set({ payrollCycle: v })}
                options={['Monthly', 'Fortnightly', 'Weekly', 'Daily']}
              />
            </Field>
            <Field label="Overtime Eligibility">
              <span className="ew-switch">
                <input
                  type="checkbox"
                  checked={d.overtime}
                  onChange={(ev) => set({ overtime: ev.target.checked })}
                  aria-label="Eligible for overtime"
                />
                Eligible for overtime
              </span>
            </Field>
            <Field label="Tax Status" req hint="For income tax calculation.">
              <Select
                value={d.taxStatus}
                onChange={(v) => set({ taxStatus: v })}
                options={['Taxable', 'Exempt']}
              />
            </Field>
            <Field label="EOBI / Social Benefits">
              <span className="ew-switch">
                <input
                  type="checkbox"
                  checked={d.eobi}
                  onChange={(ev) => set({ eobi: ev.target.checked })}
                  aria-label="Enrolled in EOBI"
                />
                Enrolled in EOBI
              </span>
            </Field>
            <Field label="Cost Center" req hint="Assign to cost center for accounting.">
              <Select
                value={d.costCentre}
                onChange={(v) => set({ costCentre: v })}
                options={['Sales & Marketing', 'Operations', 'Administration', 'Warehouse']}
              />
            </Field>
            <Field label="Payment Mode" req>
              <Select
                value={d.paymentMode}
                onChange={(v) => set({ paymentMode: v })}
                options={['Bank Transfer', 'Cash', 'Cheque']}
              />
            </Field>
          </div>
        </Card>

        <Card
          icon={<Landmark />}
          title="Bank Details"
          sub="Employee's bank account details for salary disbursement."
        >
          <div className="ew-fields">
            <Field label="Bank Name" req={d.paymentMode === 'Bank Transfer'} error={e.bankName}>
              <Select
                value={d.bankName}
                onChange={(v) => set({ bankName: v })}
                options={['Meezan Bank', 'HBL', 'UBL', 'Bank Alfalah', 'MCB', 'Allied Bank']}
                placeholder="Select bank"
                invalid={!!e.bankName}
              />
            </Field>
            <Field
              label="Account Title"
              req={d.paymentMode === 'Bank Transfer'}
              error={e.accountTitle}
            >
              <input
                value={d.accountTitle}
                onChange={(ev) => set({ accountTitle: ev.target.value })}
                placeholder="Account holder name"
                aria-invalid={!!e.accountTitle || undefined}
              />
            </Field>
            <Field
              label="IBAN / Account Number"
              req={d.paymentMode === 'Bank Transfer'}
              hint="Enter 24-digit IBAN or account number."
              error={e.iban}
            >
              <input
                value={d.iban}
                onChange={(ev) => set({ iban: ev.target.value.toUpperCase() })}
                placeholder="PK36MEZN0001234567890"
                aria-invalid={!!e.iban || undefined}
              />
            </Field>
            <Field label="Salary Remarks" full>
              <textarea
                value={d.salaryRemarks}
                onChange={(ev) => set({ salaryRemarks: ev.target.value.slice(0, 500) })}
                placeholder="Add any additional notes about salary, allowances or special conditions..."
              />
              <span className="ew-hint">{d.salaryRemarks.length}/500</span>
            </Field>
          </div>
        </Card>
      </div>

      <aside className="ew-rail">
        <div className="ew-rail-card">
          <div className="ew-rail-head">
            <WalletCards />
            <div>
              <h4>Payroll Summary</h4>
              <p>Breakdown of monthly compensation.</p>
            </div>
          </div>

          {estimate.earnings.map((r) => (
            <div className="ew-sum-row" key={r.label}>
              <span>{r.label}</span>
              <b>{money(r.amount)}</b>
            </div>
          ))}
          <div className="ew-sum-row is-total">
            <span>Gross Monthly Salary</span>
            <b>{money(estimate.gross)}</b>
          </div>

          {mismatch && (
            <div className="ew-estimate-note">
              <AlertTriangle aria-hidden="true" />
              <span>
                Components total {money(estimate.gross)} but gross salary is entered as{' '}
                {money(d.grossSalary)}. Payroll splits on the components — reconcile these before
                saving.
              </span>
            </div>
          )}

          {estimate.deductions.length > 0 && (
            <>
              <p className="ew-sum-group">Deductions (Estimated)</p>
              {estimate.deductions.map((r) => (
                <div className="ew-sum-row is-deduction" key={r.label}>
                  <span>{r.label}</span>
                  <b>- {money(r.amount)}</b>
                </div>
              ))}
            </>
          )}

          <div className="ew-net">
            <span>Estimated Net Monthly Salary</span>
            <b>{money(estimate.net)}</b>
            <span>This is an estimated amount based on current tax rules.</span>
          </div>

          {/* This disclaimer is the reason the panel is permitted to exist at all. */}
          <div className="ew-estimate-note">
            <Info aria-hidden="true" />
            <span>
              Estimate only. Deductions are illustrative and are not the FBR schedule — the payroll
              run computes and posts the authoritative figures.
            </span>
          </div>
        </div>
      </aside>
    </div>
  )
}

function DocumentsStep({ d, set, e }: { d: Draft; set: (p: Partial<Draft>) => void; e: Errors }) {
  const attach = (key: DocKey, files: FileList | null) => {
    if (!files?.length) return
    set({
      docs: {
        ...d.docs,
        [key]: [...files].map((f) => ({ name: f.name, size: f.size })),
      },
    })
  }
  const kb = (n: number) =>
    n > 1024 * 1024 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`

  const card = (key: DocKey, req: boolean) => {
    const files = d.docs[key] ?? []
    const id = `doc-${key.replace(/\W/g, '-')}`
    return (
      <div className="ew-doc" key={key}>
        <span className="ew-doc-title">
          {key}
          {req && (
            <span className="req" aria-hidden="true">
              *
            </span>
          )}
        </span>
        <div className="ew-doc-body">
          <span className="ew-doc-thumb" aria-hidden="true">
            {key === 'Profile Photo' ? <Camera size={16} /> : <FileText size={16} />}
          </span>
          <span className="ew-doc-meta">
            {files.length === 0 ? (
              <span>No file chosen</span>
            ) : files.length === 1 ? (
              <>
                <b>{files[0].name}</b>
                <span>{kb(files[0].size)}</span>
              </>
            ) : (
              <>
                <b>{files.length} files uploaded</b>
                <span>{kb(files.reduce((s, f) => s + f.size, 0))} total</span>
              </>
            )}
          </span>
          {files.length > 0 && (
            <span className="ew-doc-state" aria-label="Uploaded">
              <CircleCheck size={17} />
            </span>
          )}
        </div>
        <input
          id={id}
          type="file"
          multiple={key === 'Educational Certificates' || key === 'Additional Attachments'}
          hidden
          onChange={(ev) => attach(key, ev.target.files)}
        />
        <Button kind="secondary" onClick={() => document.getElementById(id)?.click()}>
          <Upload /> {files.length ? 'Replace file' : 'Upload'}
        </Button>
      </div>
    )
  }

  const uploaded = (k: DocKey) => (d.docs[k]?.length ?? 0) > 0

  return (
    <div className="ew-body">
      <div>
        <Card
          icon={<FileText />}
          title="Documents"
          sub="Upload the required documents for this employee. Supported formats: PDF, JPG, PNG (max 5MB each)."
        >
          {e.docs && (
            <p className="ew-error" role="alert" style={{ marginBottom: 'var(--sp-4)' }}>
              {e.docs}
            </p>
          )}
          <div className="ew-doc-grid">
            {REQUIRED_DOCS.map((k) => card(k, true))}
            {OPTIONAL_DOCS.map((k) => card(k, false))}
            <div className="ew-doc-drop">
              <Paperclip aria-hidden="true" />
              <b>Add more documents (optional)</b>
              <span>Supports PDF, JPG, PNG (max 5MB each)</span>
            </div>
          </div>
        </Card>
      </div>

      <aside className="ew-rail">
        <div className="ew-rail-card is-accent">
          <div className="ew-rail-head">
            <ShieldCheck />
            <div>
              <h4>Secure Document Upload</h4>
              <p>
                Documents are stored with role-based access. CNIC and bank proof are personal data.
              </p>
            </div>
          </div>
        </div>
        <div className="ew-rail-card">
          <div className="ew-rail-head">
            <ClipboardCheck />
            <div>
              <h4>Required Documents Checklist</h4>
              <p>Four documents are mandatory.</p>
            </div>
          </div>
          <ul className="ew-list">
            {[...REQUIRED_DOCS, ...OPTIONAL_DOCS].map((k) => (
              <li key={k}>
                {uploaded(k) ? (
                  <CircleCheck className="ok" aria-hidden="true" />
                ) : (
                  <Info className="no" aria-hidden="true" />
                )}
                <span style={{ flex: 1 }}>{k}</span>
                <span className="ew-hint">
                  {uploaded(k)
                    ? 'Uploaded'
                    : (REQUIRED_DOCS as readonly string[]).includes(k)
                      ? 'Required'
                      : 'Optional'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  )
}

function ReviewStep({
  d,
  set,
  e,
  estimate,
  goTo,
}: {
  d: Draft
  set: (p: Partial<Draft>) => void
  e: Errors
  estimate: ReturnType<typeof estimatePayroll>
  goTo: (step: number) => void
}) {
  const fullName = `${d.firstName} ${d.lastName}`.trim() || '—'
  const maskedCnic = d.cnic ? d.cnic.replace(/^\d{5}-\d{4}/, '•••••-••••') : '—'
  const section = (title: string, step: number, body: ReactNode) => (
    <section className="ew-card">
      <div className="ew-review-head">
        <h3>{title}</h3>
        <Button kind="secondary" onClick={() => goTo(step)}>
          Edit
        </Button>
      </div>
      {body}
    </section>
  )
  const cell = (label: string, value: string, num?: boolean) => (
    <div key={label}>
      <small>{label}</small>
      <b className={num ? 'num' : undefined}>{value || '—'}</b>
    </div>
  )

  return (
    <div className="ew-body">
      <div>
        {section(
          'Personal Information',
          0,
          <div className="ew-review-grid">
            {cell('Full Name', fullName)}
            {cell('Employee ID', d.employeeId, true)}
            {cell('Date of Birth', d.dob)}
            {cell('Gender', d.gender)}
            {cell('Marital Status', d.maritalStatus)}
            {cell('CNIC (masked)', maskedCnic, true)}
            {cell('Nationality', d.nationality)}
          </div>,
        )}
        {section(
          'Job & Role',
          1,
          <div className="ew-review-grid">
            {cell('Designation', d.designation)}
            {cell('Department', d.department)}
            {cell('Branch', d.branch)}
            {cell('Employment Type', d.employmentType)}
            {cell('Joining Date', d.joiningDate)}
            {cell('Reporting To', d.reportingManager)}
            {cell('Access Role', d.accessRole)}
          </div>,
        )}
        {section(
          'Contact & Address',
          2,
          <div className="ew-review-grid">
            {cell('Personal Email', d.personalEmail)}
            {cell('Company Email', d.companyEmail)}
            {cell('Mobile', d.mobile && `+92 ${d.mobile}`, true)}
            {cell('Present Address', [d.addr1, d.area, d.city].filter(Boolean).join(', '))}
            {cell('Emergency Contact', d.kinName && `${d.kinName} (${d.kinRelationship})`)}
          </div>,
        )}
        {section(
          'Compensation',
          3,
          <div className="ew-review-grid">
            {cell('Gross Salary', money(estimate.gross), true)}
            {cell('Payroll Cycle', d.payrollCycle)}
            {cell('Tax Status', d.taxStatus)}
            {cell('Cost Center', d.costCentre)}
            {cell('Payment Mode', d.paymentMode)}
            {cell('Bank', d.bankName)}
            {cell('Account', d.iban, true)}
          </div>,
        )}
        {section(
          'Documents',
          4,
          <div className="ew-review-grid">
            {[...REQUIRED_DOCS, ...OPTIONAL_DOCS]
              .filter((k) => (d.docs[k]?.length ?? 0) > 0)
              .map((k) => cell(k, 'Uploaded'))}
            {[...REQUIRED_DOCS, ...OPTIONAL_DOCS].every((k) => !(d.docs[k]?.length ?? 0)) &&
              cell('Documents', 'None uploaded')}
          </div>,
        )}
      </div>

      <aside className="ew-rail">
        <div className="ew-rail-card is-accent">
          <div className="ew-rail-head">
            <BadgeCheck />
            <div>
              <h4>{fullName}</h4>
              <p>
                {d.employeeId} · {d.designation}
              </p>
            </div>
          </div>
          <div className="ew-sum-row">
            <span>Branch</span>
            <b>{d.branch}</b>
          </div>
          <div className="ew-sum-row">
            <span>Department</span>
            <b>{d.department}</b>
          </div>
          <div className="ew-sum-row is-total">
            <span>Gross Monthly</span>
            <b>{money(estimate.gross)}</b>
          </div>
        </div>

        <div className="ew-rail-card">
          <div className="ew-rail-head">
            <ClipboardCheck />
            <div>
              <h4>Completion Checklist</h4>
              <p>What is still outstanding.</p>
            </div>
          </div>
          <ul className="ew-list">
            {STEPS.slice(0, 5).map((s, i) => {
              const ok = Object.keys(validateStep(i, d)).length === 0
              return (
                <li key={s}>
                  {ok ? (
                    <CircleCheck className="ok" aria-hidden="true" />
                  ) : (
                    <AlertTriangle className="no" aria-hidden="true" />
                  )}
                  <span style={{ flex: 1 }}>{s}</span>
                  <span className="ew-hint">{ok ? 'Complete' : 'Incomplete'}</span>
                </li>
              )
            })}
          </ul>
        </div>

        <label className="ew-confirm">
          <input
            type="checkbox"
            checked={d.confirmed}
            onChange={(ev) => set({ confirmed: ev.target.checked })}
            aria-invalid={!!e.confirmed || undefined}
          />
          <span>
            I confirm the information provided is accurate and complete, and understand it will be
            used for HR and payroll processing.
            {e.confirmed && (
              <span className="ew-error" role="alert" style={{ display: 'block' }}>
                {e.confirmed}
              </span>
            )}
          </span>
        </label>
      </aside>
    </div>
  )
}

/* ------------------------------------------------------------------- modal */

export function EmployeeFormModal({
  open,
  list,
  onClose,
  onSave,
}: {
  open: boolean
  list: string[][]
  onClose: () => void
  onSave: (e: string[]) => void
}) {
  const [step, setStep] = useState(0)
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(list))
  const [showErrors, setShowErrors] = useState(false)

  const set = (p: Partial<Draft>) => setDraft((prev) => ({ ...prev, ...p }))

  const estimate = useMemo(
    () =>
      estimatePayroll({
        components: allComponents(draft),
        taxStatus: draft.taxStatus,
        eobiEnrolled: draft.eobi,
      }),
    [draft],
  )

  if (!open) return null

  const errors = validateStep(step, draft)
  const shown = showErrors ? errors : {}
  const isLast = step === STEPS.length - 1

  const advance = () => {
    if (Object.keys(errors).length) return setShowErrors(true)
    setShowErrors(false)
    setStep((s) => Math.min(STEPS.length - 1, s + 1))
  }

  const back = () => {
    setShowErrors(false)
    setStep((s) => Math.max(0, s - 1))
  }

  const goTo = (s: number) => {
    setShowErrors(false)
    setStep(s)
  }

  /* The register row is the only thing the demo store holds. Everything else the
   * wizard collects needs the HR API — see OBSERVED in the task report. */
  const create = () => {
    if (Object.keys(errors).length) return setShowErrors(true)
    onSave([
      draft.employeeId,
      `${draft.firstName} ${draft.lastName}`.trim(),
      draft.designation,
      draft.branch,
      money(estimate.gross),
      'Present',
    ])
    onClose()
  }

  return (
    <Modal title="Add New Employee" size="xl" eyebrow="HR & Payroll" onClose={onClose}>
      <p className="ew-sub">
        Add a new team member to your organization. Fill in the details step by step.
      </p>

      <div className="ew-steps" role="group" aria-label={`Step ${step + 1} of ${STEPS.length}`}>
        {STEPS.map((s, i) => (
          <Fragment key={s}>
            {i > 0 && <span className={`ew-step-line ${i <= step ? 'is-done' : ''}`} />}
            <span
              className={`ew-step ${i === step ? 'is-current' : ''} ${i < step ? 'is-done' : ''}`}
              aria-current={i === step ? 'step' : undefined}
            >
              <span className="ew-step-dot">
                {i < step ? <Check size={14} aria-hidden="true" /> : i + 1}
              </span>
              <span className="ew-step-label">{s}</span>
            </span>
          </Fragment>
        ))}
      </div>
      <p className="ew-steps-compact">
        Step {step + 1} of {STEPS.length} · {STEPS[step]}
      </p>

      {step === 0 && <PersonalStep d={draft} set={set} e={shown} />}
      {step === 1 && <JobStep d={draft} set={set} e={shown} />}
      {step === 2 && <AddressStep d={draft} set={set} e={shown} />}
      {step === 3 && <CompensationStep d={draft} set={set} e={shown} estimate={estimate} />}
      {step === 4 && <DocumentsStep d={draft} set={set} e={shown} />}
      {step === 5 && <ReviewStep d={draft} set={set} e={shown} estimate={estimate} goTo={goTo} />}

      <div className="ew-foot">
        {showErrors && Object.keys(errors).length > 0 && (
          <span className="ew-foot-msg" role="alert">
            {Object.keys(errors).length} field(s) need attention on this step.
          </span>
        )}
        <div className="ew-foot-right">
          <Button kind="secondary" onClick={onClose}>
            Cancel
          </Button>
          {step > 0 && (
            <Button kind="secondary" onClick={back}>
              <ChevronLeft /> Previous
            </Button>
          )}
          <Button kind="secondary" onClick={onClose}>
            <Save /> Save draft
          </Button>
          {isLast ? (
            <Button onClick={create}>
              <Contact /> Create employee
            </Button>
          ) : (
            <Button onClick={advance}>
              Save &amp; next <ArrowRight />
            </Button>
          )}
        </div>
      </div>
    </Modal>
  )
}
