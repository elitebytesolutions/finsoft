'use client'
import { useEffect, useRef, type FormEvent, type ReactNode } from 'react'
import { Loader2, Search, TrendingUp, X, type LucideIcon } from 'lucide-react'

export function Button({
  children,
  onClick,
  kind = 'primary',
  type = 'button',
  disabled = false,
  busy = false,
}: {
  children: ReactNode
  onClick?: () => void
  kind?: 'primary' | 'secondary' | 'ghost' | 'danger'
  type?: 'button' | 'submit'
  disabled?: boolean
  /** §B1: spinner replaces the leading icon, label stays, pointer-events off.
   * Also disables the button — pairs with the idempotent-submit rule so a
   * busy submit button cannot be clicked twice. */
  busy?: boolean
}) {
  const inactive = disabled || busy || (!onClick && type !== 'submit')
  return (
    <button
      title={!busy && inactive ? 'Available in the connected backend edition' : undefined}
      disabled={inactive}
      aria-busy={busy || undefined}
      type={type}
      onClick={onClick}
      className={`btn ${kind}${busy ? ' busy' : ''}`}
    >
      {busy && <Loader2 className="btn-spinner" size={15} aria-hidden="true" />}
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
  size,
  eyebrow = 'Finsoft workspace',
}: {
  title: string
  children: ReactNode
  onClose: () => void
  wide?: boolean
  /** Overrides `wide`. `xl` is for multi-step record forms with a summary rail. */
  size?: 'md' | 'wide' | 'xl'
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
          last = focusable.at(-1)
        /*
         * A dialog can legitimately contain nothing focusable — an empty
         * state, a spinner, a message. There is then nothing to trap, and
         * without this guard Tab threw a TypeError on `first.focus()`.
         *
         * Caught the moment packages/ui was first typechecked: it had no
         * tsconfig and no typecheck script, so `--workspaces --if-present`
         * skipped it and nothing compiler-checked this file at all.
         */
        if (!first || !last) return
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
        className={`modal ${size ?? (wide ? 'wide' : '')}`}
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
/** §C1 `Field`. Label → control → helper *or* error (never both).
 *
 * ID ownership: the CALLER owns the id — pass the same string as `htmlFor`
 * here and as `id` on the control inside. Field does not clone or inspect
 * `children`, so it derives the message id deterministically from `htmlFor`
 * (`${htmlFor}-error` / `${htmlFor}-helper`) instead of generating and
 * returning one. Wire it up on the control explicitly:
 *
 *   <Field label="Email" htmlFor="login-email" error={err}>
 *     <TextInput id="login-email" aria-invalid={!!err}
 *       aria-describedby={err ? 'login-email-error' : undefined} ... />
 *   </Field>
 *
 * This stays explicit rather than magic (no `cloneElement` reaching into an
 * arbitrary child), which keeps Field usable in front of any control, not
 * only `TextInput`. */
export function Field({
  label,
  htmlFor,
  error,
  helper,
  required = false,
  children,
}: {
  label: string
  htmlFor: string
  error?: string
  helper?: string
  required?: boolean
  children: ReactNode
}) {
  return (
    <div className={`field${error ? ' has-error' : ''}`}>
      <label className="field-label" htmlFor={htmlFor}>
        {label}
        {required && (
          <span className="field-required" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {children}
      {error ? (
        <p className="field-message error" id={`${htmlFor}-error`} role="alert">
          {error}
        </p>
      ) : helper ? (
        <p className="field-message helper" id={`${htmlFor}-helper`}>
          {helper}
        </p>
      ) : null}
    </div>
  )
}

/** §C2 `TextInput`. Pairs with `Field` — see its id-ownership note above.
 * `size="dense"` is the 35px table/toolbar height; `size="form"` (default) is
 * the 40px entry-form height. */
export function TextInput({
  id,
  type = 'text',
  value,
  onChange,
  autoComplete,
  disabled = false,
  placeholder,
  name,
  required,
  size = 'form',
  'aria-invalid': ariaInvalid,
  'aria-describedby': ariaDescribedby,
}: {
  id: string
  type?: 'text' | 'email' | 'password'
  value: string
  onChange: (v: string) => void
  autoComplete?: string
  disabled?: boolean
  placeholder?: string
  name?: string
  required?: boolean
  size?: 'form' | 'dense'
  'aria-invalid'?: boolean
  'aria-describedby'?: string
}) {
  return (
    <input
      id={id}
      name={name}
      type={type}
      className={`text-input${size === 'dense' ? ' dense' : ''}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      autoComplete={autoComplete}
      disabled={disabled}
      placeholder={placeholder}
      required={required}
      aria-invalid={ariaInvalid}
      aria-describedby={ariaDescribedby}
    />
  )
}

/** Persistent, non-dismissable, page/shell-level alert bar. Distinct from the
 * per-field `InlineWarning` in §F. `role="status"` — an implicit *polite*
 * live region, so it is announced once without interrupting, and is safe on
 * every page load (never `role="alert"`, which is for urgent/interruptive
 * feedback like a failed post — see 06-accessibility.md). There is
 * deliberately no dismiss affordance; a `PeriodLockedBanner` should build on
 * this rather than fork it. */
export function Banner({
  tone = 'neutral',
  icon: Icon,
  children,
}: {
  tone?: 'info' | 'warn' | 'danger' | 'neutral'
  children: ReactNode
  icon?: LucideIcon
}) {
  return (
    <div className={`banner ${tone}`} role="status">
      {Icon && <Icon size={16} aria-hidden="true" />}
      <div className="banner-body">{children}</div>
    </div>
  )
}

export type { FormEvent }
