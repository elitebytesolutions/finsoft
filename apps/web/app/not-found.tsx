'use client'
/* The prototype's catch-all: <Route path="*" element={<Navigate to="/dashboard"/>}/> */
import { Navigate } from '@/lib/router'

export default function NotFound() {
  return <Navigate to="/dashboard" />
}
