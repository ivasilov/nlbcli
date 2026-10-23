import fs from "node:fs"
import path from "node:path"
import { load } from "cheerio"
import { dateFmt } from "../constants"
import { bankResponseError, CliError, EXIT_CODES } from "../errors"
import {
  validateExportResponse,
  validatePdf,
  validateXls,
  writeExport,
} from "../exports"
import { formatCsv, formatJson, formatTab } from "../formatters"
import { type HttpResponse, nlbPost } from "../http"

export type TransactionsResult =
  | { kind: "file"; path: string; bytes: number }
  | {
      kind: "data"
      headers: string[]
      rows: string[][]
      jsonRows: Record<string, string>[]
    }
  | null

const datePattern = /^(\d{2})\.(\d{2})\.(\d{4})$/
const filenameRegex = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/
const defaultPageSize = 100
const pageLinkPattern = /(?:PageNumber|page)[=('/\s]+(\d+)/i
export const cardTransactionFormats = ["tab", "csv", "json", "xls"]

function formatTransactionData(
  result: Exclude<TransactionsResult, { kind: "file" } | null>,
  format: string
): string {
  if (format === "json") {
    return formatJson(result.jsonRows)
  }
  return format === "csv"
    ? formatCsv(result.rows, result.headers)
    : formatTab(result.rows)
}

export function printTransactionsResult(
  result: TransactionsResult,
  format: string
): void {
  if (!result) {
    if (format === "json") {
      console.log(formatJson([]))
    }
    console.error("No transactions found.")
  } else if (result.kind === "file") {
    console.error(`SAVED: ${result.path} (${result.bytes} bytes)`)
  } else {
    console.log(formatTransactionData(result, format))
  }
}

function parseDate(value: string): number {
  const match = value.match(datePattern)
  if (match) {
    const [, day, month, year] = match.map(Number)
    const date = new Date(year, month - 1, day)
    if (
      date.getFullYear() === year &&
      date.getMonth() === month - 1 &&
      date.getDate() === day
    ) {
      return date.getTime()
    }
  }
  throw new CliError(
    EXIT_CODES.arguments,
    `Invalid date "${value}". Use dd.mm.yyyy.`
  )
}

export function transactionDates(start?: string, end?: string) {
  const today = new Date()
  const monthAgo = new Date(today)
  monthAgo.setDate(monthAgo.getDate() - 30)
  return {
    start: start ?? dateFmt(monthAgo),
    end: end ?? dateFmt(today),
  }
}

export function validateTransactionOptions(
  start: string,
  end: string,
  format: string,
  output?: string,
  formats = ["tab", "csv", "json", "xls", "pdf"]
): void {
  if (parseDate(start) > parseDate(end)) {
    throw new CliError(
      EXIT_CODES.arguments,
      "Start date must be on or before end date."
    )
  }
  if (!formats.includes(format)) {
    throw new CliError(
      EXIT_CODES.arguments,
      `Invalid format "${format}". Use ${formats.join(", ")}.`
    )
  }
  if (output !== undefined) {
    if (!output.trim()) {
      throw new CliError(EXIT_CODES.arguments, "Output path must not be empty.")
    }
    if (fs.existsSync(output) && fs.statSync(output).isDirectory()) {
      throw new CliError(
        EXIT_CODES.arguments,
        "Output path must be a file, not a directory."
      )
    }
    const parent = path.dirname(path.resolve(output))
    if (!(fs.existsSync(parent) && fs.statSync(parent).isDirectory())) {
      throw new CliError(
        EXIT_CODES.arguments,
        `Output directory does not exist: ${parent}`
      )
    }
  }
}

function saveFile(
  output: string,
  body: string | Buffer,
  validate: (contents: Buffer) => void
): TransactionsResult {
  return writeExport(path.resolve(output), Buffer.from(body), validate)
}

function exportReport(
  res: HttpResponse,
  format: string,
  accountId: string,
  output?: string
): TransactionsResult {
  validateExportResponse(res)
  const disposition = String(res.headers["content-disposition"] || "")
  const validate = format === "xls" ? validateXls : validatePdf
  if (output !== undefined) {
    return saveFile(output, res.body, validate)
  }
  const match = disposition.match(filenameRegex)
  const filename = path.basename(
    match
      ? match[1].replace(/['"]/g, "")
      : `transactions_${accountId.replaceAll("/", "_")}_${dateFmt(new Date())}.${format}`
  )
  const downloads = path.join(process.cwd(), "downloads")
  fs.mkdirSync(downloads, { recursive: true })
  return saveFile(path.join(downloads, filename), res.body, validate)
}

function cardHeaders(labels: string[], columnCount: number): string[] {
  const used = new Set<string>()
  return Array.from(
    { length: Math.max(labels.length, columnCount) },
    (_, i) => {
      const label = labels[i] || `column_${i + 1}`
      let header = label
      for (let suffix = 2; used.has(header); suffix++) {
        header = `${label}_${suffix}`
      }
      used.add(header)
      return header
    }
  )
}

function parsePage(
  html: string,
  account: boolean,
  currentPage: number,
  requestedPageSize: number
) {
  const $ = load(html, { sourceCodeLocationInfo: true })
  const invalid = () =>
    bankResponseError(
      "NLB did not return a valid transactions table (incomplete transaction table or document)."
    )
  // Cheerio repairs truncated HTML; require real closing tags before exporting.
  for (const element of $("html, body").toArray()) {
    const location = element.sourceCodeLocation
    if (location?.startTag && !location.endTag) {
      throw invalid()
    }
  }
  const table = $("table")
    .filter((_i, el) => $(el).find("tbody").length > 0)
    .first()
  if (!table.get(0)?.sourceCodeLocation?.endTag) {
    throw invalid()
  }
  const columnHeaders = table
    .find("thead th")
    .map((_i, el) => $(el).text().trim())
    .get()
  const headers = account
    ? ["date", "recipient", "description", "status", "amount", "fee", "balance"]
    : []
  const rows: string[][] = []
  table.find("tbody > tr").each((_i, tr) => {
    if (!tr.sourceCodeLocation?.endTag) {
      throw invalid()
    }
    const cells = $(tr).children("td")
    if (cells.length === 0 || cells.is("[colspan]")) {
      return
    }
    const values = cells.map((_j, td) => $(td).text().trim()).get()
    if (account) {
      if (values.length < 8) {
        throw invalid()
      }
      rows.push(values.slice(1, 8))
    } else {
      rows.push(values)
    }
  })
  if (!account) {
    headers.push(...cardHeaders(columnHeaders, rows[0]?.length ?? 0))
  }
  return { headers, rows, ...pagination($, currentPage, requestedPageSize) }
}

function pagination(
  $: ReturnType<typeof load>,
  currentPage: number,
  requestedPageSize: number
) {
  const next = $(
    ".pagination .next, .pager .next, .PagedList-skipToNext, [rel=next]"
  )
  const nextDisabled =
    next.length > 0 &&
    next
      .toArray()
      .every(
        (el) =>
          $(el).is(".disabled, [disabled], [aria-disabled=true]") ||
          $(el).parent().is(".disabled, [aria-disabled=true]")
      )
  const pageNumbers = $(
    ".pagination a, .pager a, .pagination button, [data-page], [data-page-number]"
  )
    .map((_i, el) => {
      const link = $(el)
      return (
        Number(
          link.attr("data-page") ||
            link.attr("data-page-number") ||
            link.attr("href")?.match(pageLinkPattern)?.[1] ||
            link.attr("onclick")?.match(pageLinkPattern)?.[1] ||
            link.text().trim()
        ) || 0
      )
    })
    .get()
  const totalPages = Number($("[name=TotalPages], [name=PageCount]").val()) || 0
  const actualPageSize = Number($("[name=PageSize]").val()) || requestedPageSize
  return {
    nextDisabled,
    hasNext:
      (next.length > 0 && !nextDisabled) ||
      Math.max(totalPages, ...pageNumbers) > currentPage,
    pageSize: actualPageSize,
  }
}

export async function fetchTransactions(
  cookie: string,
  endpoint: string,
  data: Record<string, string>,
  format: string,
  output?: string
): Promise<TransactionsResult> {
  const request: Record<string, string> = {
    ...data,
    PageSize: data.PageSize || String(defaultPageSize),
    PageNumber: "1",
  }
  if (["xls", "pdf"].includes(format)) {
    request.Report = format === "xls" ? "Excel" : "Pdf"
    const res = await nlbPost(endpoint, cookie, request)
    return exportReport(res, format, data.AccountID, output)
  }

  const rows: string[][] = []
  let headers: string[] = []
  const seen = new Set<string>()
  for (let page = 1; ; page++) {
    request.PageNumber = String(page)
    const res = await nlbPost(endpoint, cookie, request)
    validateExportResponse(res)
    const parsed = parsePage(
      res.body.toString("utf-8"),
      endpoint === "/Retail/Transactions",
      page,
      Number(request.PageSize)
    )
    if (page === 1) {
      headers = parsed.headers
    }
    if (parsed.rows.length === 0) {
      break
    }
    const signature = JSON.stringify(parsed.rows)
    if (seen.has(signature)) {
      throw bankResponseError(
        "NLB repeated a transaction page; export is incomplete."
      )
    }
    seen.add(signature)
    rows.push(...parsed.rows)
    if (
      parsed.nextDisabled ||
      (!parsed.hasNext && parsed.rows.length < parsed.pageSize)
    ) {
      break
    }
  }
  const jsonRows = rows.map((row) =>
    Object.fromEntries(headers.map((header, i) => [header, row[i] ?? ""]))
  )
  const result = { kind: "data" as const, headers, rows, jsonRows }
  if (output !== undefined) {
    return saveFile(
      output,
      `${formatTransactionData(result, format)}\n`,
      (contents) => {
        if (format === "json") {
          JSON.parse(contents.toString("utf-8"))
        }
      }
    )
  }
  return rows.length === 0 ? null : result
}
