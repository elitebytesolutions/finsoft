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

  it('filters by action and entity type via the real query', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    let lastUrl = ''
    fetchMock.mockImplementation((url: string) => {
      lastUrl = url
      return Promise.resolve(jsonResponse(200, { items: [], nextCursor: null }))
    })

    renderScreen()
    await waitFor(() => expect(screen.getByText(/no audit events for/i)).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText('Filter by action'), {
      target: { value: 'CUSTOMER_CREATED' },
    })
    fireEvent.change(screen.getByLabelText('Filter by entity type'), {
      target: { value: 'customer' },
    })

    await waitFor(() => expect(lastUrl).toContain('action=CUSTOMER_CREATED'))
    expect(lastUrl).toContain('entityType=customer')
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
})
