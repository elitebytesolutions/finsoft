# Print documents

| | |
|---|---|
| **Route** | `/purchasing/print` |
| **Archetype** | H — Report (document printing) |
| **Module / permission** | Purchasing · `Purchasing` |
| **Prototype source** | `ui-prototype/src/print-documents.tsx` (`PrintDocuments`) |
| **Reference frame** | `ui-prototype/design/create prints page .png` |
| **Posts to the ledger** | no |

## 1. Purpose

Select documents and print them in a batch — GRNs for the warehouse, purchase invoices for the file,
labels for the shelf. Distribution businesses print daily, so this is a real workflow, not an
afterthought.

## 2. Anatomy

```
PageHead   "Print Documents" · [Print selected] [Download PDF]
Grid       [ Selection panel ]                  [ Preview ]
             document type · date range ·         A4 page preview with zoom and page nav
             supplier · status · search
             ☐ document list
           [ Layout options ] letterhead · copies (Original / Duplicate / Triplicate) ·
             include prices · include batch/expiry · signature block
Preview    Live `PrintDocument` render of the first selected document
```

## 3. Components

`DataTable` (selectable document list) · `PrintPreview` (page-local viewer) · `FormSection`
(layout options) · `PrintDocument` (D12) · `ExportMenu`.

## 4. Document types

Purchase invoice · Goods receipt note · Purchase order · Debit note · Product/shelf labels ·
Supplier statement. Each has a fixed layout; the options change what the layout includes, never its
structure.

## 5. Printed content requirements

Every printed document carries: company name, address, NTN/STRN · document title · document number ·
date and period · party block · line table with full precision · totals · amount in words ·
copy marking (Original / Duplicate) · signature strip · `Generated on <date time> by <user>` ·
page `n of m`.

A print with prices hidden still shows quantities and batch/expiry — the warehouse copy must be
reconcilable without revealing cost.

## 6. Actions

| Action | Kind | Permission | Confirm | Result |
|---|---|---|---|---|
| Print selected | primary | `Purchasing` | yes when over 20 documents | Opens the browser print dialog with all selected documents in one job |
| Download PDF | secondary | `Purchasing` | no | One PDF, one document per page range |
| Reprint | row | `Purchasing` | no | Marks the document as reprinted in its timeline |

## 7. Rules

- Reprints are **recorded** on the document's timeline with user and timestamp — a second "Original"
  in circulation is an audit matter.
- The copy marking is printed, not just selected.
- Printing never changes a document's status.

## 8. States

Nothing selected → the preview shows a placeholder, not a blank page.
A document whose layout is not configured → named in an inline warning rather than printing blank.

## 9. Responsive · 10. Accessibility

`md` the preview moves below the selection panel · `sm` preview is replaced by a download action.
The preview has a text alternative listing the documents to be printed; zoom controls are buttons
with accessible names.

## 11. Open questions

1. Is this screen purchasing-only, or should it become a shared `/print` for all document types?
   (Recommendation: shared, with a type filter.)
2. Are letterheads per branch?
3. Do label prints need a barcode symbology decision (Code 128 vs EAN-13)?
