import { previewInvoiceLines, type InvoiceLineInput, type InvoicePreview } from '../domain/invoice.ts'

/** I6. Stateless: writes nothing, opens no transaction (api-contract.md §2). */
export interface CalculateInvoiceCommand {
  readonly lines: readonly InvoiceLineInput[]
}

export function createCalculateInvoice() {
  return function calculateInvoice(command: CalculateInvoiceCommand): InvoicePreview {
    return previewInvoiceLines(command.lines)
  }
}
