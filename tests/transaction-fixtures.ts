import fs from "node:fs"
import { parse } from "csv-parse/sync"
import { readXls } from "xls-reader"

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
export const normalizedRows = [
  [
    "2026-08-01",
    'Примач, "Example"',
    'Payment, "quoted"\nsecond line',
    "Completed",
    "1234.50",
    "0.00",
    "9876.50",
  ],
]
export const jsonRows = normalizedRows.map((row) =>
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
  return fs.readFileSync(
    new URL("./fixtures/accounts/report.xls", import.meta.url)
  )
}

export function readTransactionExport(format: string, contents: Buffer) {
  if (format === "json") {
    return JSON.parse(contents.toString("utf-8"))
  }
  if (format === "csv") {
    return parse(contents)
  }
  return readXls(contents).sheets[0].rows
}
