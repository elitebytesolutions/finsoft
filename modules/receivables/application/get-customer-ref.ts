import { withTenant } from '@finsoft/database'
import type { CustomerDirectory, CustomerRef } from '@finsoft/customers/published'

/**
 * A small read-only helper so a mutation's controller can build a full
 * response DTO (which needs `customer.code`/`name`) without every
 * create/update/post/reverse use case threading a customer ref through its
 * own result type. Absent ids resolve to an empty placeholder rather than
 * throwing — a mutation already validated the customer exists.
 */
export function createGetCustomerRef(customerDirectory: CustomerDirectory) {
  return async function getCustomerRef(id: string): Promise<CustomerRef> {
    return withTenant(async (tx) => {
      const refs = await customerDirectory.getRefs(tx, [id])
      return refs.get(id) ?? { id, code: '', name: '', status: 'ACTIVE' as const }
    })
  }
}
