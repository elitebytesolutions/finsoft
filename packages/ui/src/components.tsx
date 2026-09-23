'use client'
import { useEffect, useRef, type FormEvent, type ReactNode } from 'react'
import { Search, TrendingUp, X, type LucideIcon } from 'lucide-react'

export function Button({
  children,
  onClick,
  kind = 'primary',
  type = 'button',
  disabled = false,
}: {
  children: ReactNode
  onClick?: () => void
  kind?: 'primary' | 'secondary' | 'ghost' | 'danger'
  type?: 'button' | 'submit'
  disabled?: boolean
}) {
  const inactive = disabled || (!onClick && type !== 'submit')
  return (
    <button
      title={inactive ? 'Available in the connected backend edition' : undefined}
      disabled={inactive}
      type={type}
      onClick={onClick}
      className={`btn ${kind}`}
    >
      {children}
    </button>
  )
}
export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode
  tone?: 'good' | 'warn' | 'danger' | 'info' | 'neutral'
}) {
  return <span className={`badge ${tone}`}>{children}</span>
}
export function PageHead({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string
  title: string
  description: string
  actions?: ReactNode
}) {
  return (
    <div className="page-head">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions && <div className="head-actions">{actions}</div>}
    </div>
  )
}
export function Kpi({
  label,
  value,
  change,
  icon: Icon,
  tone = 'green',
}: {
  label: string
  value: string
  change: string
  icon: LucideIcon
  tone?: string
}) {
  return (
    <article className={`kpi ${tone}`}>
      <div className="kpi-top">
        <span>{label}</span>
        <span className="icon-well">
          <Icon size={18} />
        </span>
      </div>
      <strong>{value}</strong>
      <small>
        <TrendingUp size={13} />
        {change}
      </small>
    </article>
  )
}
export function Panel({
  title,
  sub,
  children,
  action,
}: {
  title: string
  sub?: string
  children: ReactNode
  action?: ReactNode
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h3>{title}</h3>
          {sub && <p>{sub}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}
export function SearchField({
  value,
  onChange,
  placeholder = 'Search records...',
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <label className="search-field">
      <Search size={16} />
      <input
        aria-label={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </label>
  )
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
  eyebrow = 'Finsoft workspace',
}: {
  title: string
  children: ReactNode
  onClose: () => void
  wide?: boolean
  eyebrow?: string | false
}) {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    ref.current?.focus()
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'Tab' && ref.current) {
        const focusable = [
          ...ref.current.querySelectorAll<HTMLElement>(
            'button,input,select,[tabindex]:not([tabindex="-1"])',
          ),
        ]
        if (!focusable.length) return
        const first = focusable[0],
          last = focusable.at(-1)!
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('keydown', key)
      previous?.focus()
    }
  }, [onClose])
  const heading = `modal-${title.replace(/\W/g, '-')}`
  return (
    <div
      className="overlay"
      role="presentation"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <section
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={heading}
        className={`modal ${wide ? 'wide' : ''}`}
      >
        <div className="modal-head">
          <div>
            {eyebrow && <span className="eyebrow">{eyebrow}</span>}
            <h2 id={heading}>{title}</h2>
          </div>
          <button className="icon-btn" aria-label="Close dialog" onClick={onClose}>
            <X />
          </button>
        </div>
        {children}
      </section>
    </div>
  )
}
export function Table({
  headers,
  rows,
}: {
  headers: string[]
  rows: (string | number | ReactNode)[][]
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
export type { FormEvent }
