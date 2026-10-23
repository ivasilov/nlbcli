import { utils, write } from "xlsx"

export const headers = [
  "date",
  "recipient",
  "description",
  "status",
  "amount",
  "fee",
  "balance",
]
export const rows = [
  [
    "01.08.2026",
    'Примач, "Example"',
    'Payment, "quoted"\nsecond line',
    "Completed",
    "1,234.50",
    "0.00",
    "9,876.50",
  ],
]
export const jsonRows = rows.map((row) =>
  Object.fromEntries(headers.map((key, i) => [key, row[i]]))
)

export function transactionHtml(data = rows): string {
  const escapeHtml = (text: string) =>
    text
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll('"', "&quot;")
  return `<table><thead><tr><th></th>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${data.map((row) => `<tr><td></td>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`
}

export function transactionXls(): Buffer {
  const workbook = utils.book_new()
  utils.book_append_sheet(
    workbook,
    utils.aoa_to_sheet([headers, ...rows]),
    "Transactions"
  )
  return write(workbook, { type: "buffer", bookType: "biff8" })
}
