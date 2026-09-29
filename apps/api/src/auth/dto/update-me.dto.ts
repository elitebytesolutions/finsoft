import { z } from 'zod'

/*
 * PATCH /api/auth/me. M1-X, W1-006 exit criterion 1.
 *
 * The one field a user may change about themselves through this route.
 * Nothing tenant-scoping, nothing financial — see
 * packages/database/src/auth/session.ts's updateOwnFullName.
 *
 * `version`: M1-X, Council DB C3. Required, not optional — an update that
 * does not name the row version it read is not an optimistic-concurrency
 * update at all, and the caller (GET /api/auth/me, which already returns
 * nothing carrying a version today — see the controller's own note) is
 * expected to have just read it.
 */
export const UpdateMeSchema = z.object({
  fullName: z.string().trim().min(1).max(200),
  version: z.number().int().nonnegative(),
})

export type UpdateMeDto = z.infer<typeof UpdateMeSchema>
