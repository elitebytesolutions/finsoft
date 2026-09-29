import { customerDirectory } from '@finsoft/customers'
import { createReceivablesUseCases, type ReceivablesUseCases } from '@finsoft/receivables'

/*
 * M3-P composition: `modules/receivables`' use cases, built once with
 * `modules/customers`' published `CustomerDirectory` implementation
 * (docs/design/M3/modules.md §3: "apps/api builds it and passes it into
 * the receivables use-case factories"). The module itself never imports
 * `modules/customers` beyond `@finsoft/customers/published` — this is the
 * ONE place the concrete instance is wired in.
 */
export const receivables: ReceivablesUseCases = createReceivablesUseCases(customerDirectory)
