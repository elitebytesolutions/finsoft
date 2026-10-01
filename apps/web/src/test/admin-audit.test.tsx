/* Component tests for /admin-audit (docs/design-system/pages/audit-trail/README.md), the
 * "Audit log" tab of Admin (app-screens.tsx). M4-W wired it to the real `GET /api/audit`
 * (AuditLogPanel) — the rest of Admin (Users, Roles, Sessions) stays on mock data,
 * untouched, and is out of this lane's scope. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from './harness'
import { Admin } from '@/screens/app-screens'
import { AuthContext, type AuthContextValue } from '@/lib/api/auth-context'
import { setAccessToken } from '@/lib/api/session'
import { startOfLocalDayIso } from '@/lib/date/local-date'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function authValue(can: (code: string) => boolean): AuthContextValue {
  return {
    status: 'authenticated',
    user: { id: 'u1', fullName: 'Test User', email: 'u1@example.com' },
    tenant: { id: 't1', code: 'TEST', name: 'Test Tenant' },
    sessionId: 's1',
    permissionVersion: 1,
    permissions: ['all'],
    errorMessage: null,
    retry: () => {},
    syncAfterLogin: async () => {},
    signOut: async () => {},
    can,
  }
}

const AUDIT_PAGE = {
  items: [
    {
      id: 'a1',
      seq: 2,
      occurredAt: '2026-09-29T10:27:14.000Z',
      actorUserId: 'user-bbbbbbbb-1111',
      action: 'SALE_POSTED',
      entityType: 'sales_invoice',
      entityId: 'inv-1',
      beforeJson: null,
      afterJson: null,
      ip: '10.0.0.1',
      requestId: 'r1',
      hash: 'h1',
    },
    {
      id: 'a2',
      seq: 1,
      occurredAt: '2026-09-29T09:00:00.000Z',
      actorUserId: 'user-bbbbbbbb-1111',
      action: 'PERMISSION_DENIED',
      entityType: 'customer',
      entityId: 'c1',
      beforeJson: null,
      afterJson: null,
      ip: '10.0.0.1',
      requestId: 'r2',
      hash: 'h2',
    },
  ],
  nextCursor: null,
}

beforeEach(() => {
  setAccessToken('tok-1')
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderScreen(can: (code: string) => boolean = () => true) {
  return render(
    <MemoryRouter initialEntries={['/admin-audit']}>
      <AuthContext.Provider value={authValue(can)}>
        <Admin role="Owner" setRole={() => {}} initialTab="Audit log" />
      </AuthContext.Provider>
    </MemoryRouter>,
  )
}

describe('Admin — Audit log tab (real API)', () => {
  it('lists real audit events, newest first, with a humanized action and outcome', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValue(jsonResponse(200, AUDIT_PAGE))

    renderScreen()

    await waitFor(() => expect(screen.getAllByText('Sale posted').length).toBeGreaterThan(0))
    expect(screen.getAllByText('Permission denied').length).toBeGreaterThan(0)
    expect(screen.getByText('Success')).toBeInTheDocument()
    expect(screen.getByText('Denied')).toBeInTheDocument()
  })

  it('shows the empty state for the selected range', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValue(jsonResponse(200, { items: [], nextCursor: null }))

    renderScreen()
    await waitFor(() => expect(screen.getByText(/no audit events for/i)).toBeInTheDocument())
  })

  it('filters by action and entity type only after Apply filters, via the kit Field/TextInput', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    let lastUrl = ''
    let calls = 0
    fetchMock.mockImplementation((url: string) => {
      lastUrl = url
      calls += 1
      return Promise.resolve(jsonResponse(200, { items: [], nextCursor: null }))
    })

    renderScreen()
    await waitFor(() => expect(screen.getByText(/no audit events for/i)).toBeInTheDocument())
    const callsBeforeTyping = calls

    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'CUSTOMER_CREATED' } })
    fireEvent.change(screen.getByLabelText('Entity type'), { target: { value: 'customer' } })
    // Typing alone must not re-query — only Apply filters does (the Customers filter bar's
    // own Apply/Reset pattern, not a live-as-you-type query).
    expect(calls).toBe(callsBeforeTyping)

    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }))

    await waitFor(() => expect(lastUrl).toContain('action=CUSTOMER_CREATED'))
    expect(lastUrl).toContain('entityType=customer')
    // There is no Actor id filter any more — no endpoint exists to resolve one to a name.
    expect(screen.queryByLabelText(/actor/i)).not.toBeInTheDocument()
  })

  it('never calls the API and shows Denied for a caller without audit.view — a Viewer', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValue(jsonResponse(200, AUDIT_PAGE))

    renderScreen(() => false)

    expect(
      screen.getByText(/your role does not have permission to view the audit trail/i),
    ).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shows "You" for the signed-in user\'s own events and a short id for anyone else', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        items: [{ ...AUDIT_PAGE.items[0], actorUserId: 'u1' }, AUDIT_PAGE.items[1]],
        nextCursor: null,
      }),
    )

    renderScreen()

    await waitFor(() => expect(screen.getByText('You')).toBeInTheDocument())
    expect(screen.getByText('User · user…')).toBeInTheDocument()
    expect(screen.queryByText('user-bbbbbbbb-1111')).not.toBeInTheDocument()
  })

  it('shows no fabricated security-posture banner, and an honest one instead', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValue(jsonResponse(200, { items: [], nextCursor: null }))

    renderScreen()
    await waitFor(() => expect(screen.getByText(/no audit events for/i)).toBeInTheDocument())

    expect(screen.queryByText(/security posture is strong/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/2fa is enabled/i)).not.toBeInTheDocument()
    expect(screen.queryByText('92 / 100')).not.toBeInTheDocument()
    expect(
      screen.getByText(
        /every security-sensitive action, in order, with a tamper-evident hash chain/i,
      ),
    ).toBeInTheDocument()
  })

  it('shows Invite user disabled for admin.user_manage, and hides it otherwise', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValue(jsonResponse(200, { items: [], nextCursor: null }))

    const { unmount } = renderScreen((code) => code === 'admin.user_manage')
    await waitFor(() => expect(screen.getByRole('button', { name: /invite user/i })).toBeDisabled())
    unmount()

    renderScreen(() => false)
    await waitFor(() =>
      expect(screen.getAllByRole('heading', { level: 1 }).length).toBeGreaterThan(0),
    )
    expect(screen.queryByRole('button', { name: /invite user/i })).not.toBeInTheDocument()
  })

  it('never shows the full actor uuid, not even as a hover title', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValue(jsonResponse(200, AUDIT_PAGE))

    renderScreen()
    await waitFor(() => expect(screen.getAllByText(/^User · /).length).toBeGreaterThan(0))
    expect(document.querySelector('[title="user-bbbbbbbb-1111"]')).toBeNull()
    expect(screen.queryByText('user-bbbbbbbb-1111')).not.toBeInTheDocument()
  })

  it('splits DENIED (warn, "Denied") from FAIL (danger, "Failed") from everything else (good, "Success")', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        items: [
          { ...AUDIT_PAGE.items[0], id: 'ok', action: 'CUSTOMER_CREATED' },
          { ...AUDIT_PAGE.items[0], id: 'denied', action: 'PERMISSION_DENIED' },
          { ...AUDIT_PAGE.items[0], id: 'failed', action: 'LOGIN_FAILED' },
        ],
        nextCursor: null,
      }),
    )

    renderScreen()

    const success = await screen.findByText('Success')
    expect(success.className).toContain('good')
    const denied = screen.getByText('Denied')
    expect(denied.className).toContain('warn')
    const failed = screen.getByText('Failed')
    expect(failed.className).toContain('danger')
  })

  it('sends an inclusive "To" date — the start of the next local day, not that day\'s own midnight UTC', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    let lastUrl = ''
    fetchMock.mockImplementation((url: string) => {
      lastUrl = url
      return Promise.resolve(jsonResponse(200, { items: [], nextCursor: null }))
    })

    renderScreen()
    await waitFor(() => expect(screen.getByText(/no audit events for/i)).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-09-29' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }))

    await waitFor(() => expect(lastUrl).toContain('to='))
    const to = decodeURIComponent(new URL(lastUrl, 'http://x').searchParams.get('to')!)
    // Start of 2026-09-30 local, not 2026-09-29T00:00:00.000Z (which would exclude the
    // whole selected day in any timezone ahead of UTC).
    expect(to.startsWith('2026-09-29T00:00:00')).toBe(false)
    expect(new Date(to).getTime()).toBeGreaterThan(new Date('2026-09-29T23:59:59.000Z').getTime())
  })

  it('sends the start of the selected LOCAL day as "From", not that day\'s own midnight UTC', async () => {
    // Deliberately does not set process.env.TZ: local-date.test.tsx already proves
    // startOfLocalDayIso's PKT arithmetic (02:00 PKT) in isolation, with the TZ mutation
    // scoped to tests that run strictly sequentially within that one file. Mutating the
    // same process-global TZ from a second file risks racing whatever other file happens
    // to share this worker — this test instead asserts AuditLogPanel calls that same real
    // function, under whatever timezone this run already has, which is exactly what matters:
    // the wiring, not a second copy of the date arithmetic.
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    let lastUrl = ''
    fetchMock.mockImplementation((url: string) => {
      lastUrl = url
      return Promise.resolve(jsonResponse(200, { items: [], nextCursor: null }))
    })

    renderScreen()
    await waitFor(() => expect(screen.getByText(/no audit events for/i)).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-09-29' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }))

    await waitFor(() => expect(lastUrl).toContain('from='))
    const from = decodeURIComponent(new URL(lastUrl, 'http://x').searchParams.get('from')!)
    // Matches the real, independently-tested (local-date.test.tsx, at 02:00 PKT)
    // startOfLocalDayIso — never the naive new Date(dateStr).toISOString() that is that
    // date's own UTC midnight and silently drops the first few hours of the local day in
    // any timezone ahead of UTC.
    expect(from).toBe(startOfLocalDayIso('2026-09-29'))
  })

  it('shows an error, not a silent failure, when Load more itself fails', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse(200, { items: AUDIT_PAGE.items, nextCursor: 'cursor-2' })),
    )

    renderScreen()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument(),
    )

    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse(500, { statusCode: 500, error: 'internal', message: 'boom' })),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))

    await waitFor(() =>
      expect(screen.getByText(/could not load more audit events/i)).toBeInTheDocument(),
    )
    // The button survives the failure — the user can retry rather than losing the action.
    expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument()
  })
})
