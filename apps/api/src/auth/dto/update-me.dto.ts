import { z } from 'zod'

/*
 * PATCH /api/auth/me. M1-X, W1-006 exit criterion 1.
 *
 * The one field a user may change about themselves through this route.
 * Nothing tenant-scoping, nothing financial — see
 * packages/database/src/auth/session.ts's updateOwnFullName.
 */
export const UpdateMeSchema = z.object({
  fullName: z.string().trim().min(1).max(200),
})

export type UpdateMeDto = z.infer<typeof UpdateMeSchema>
