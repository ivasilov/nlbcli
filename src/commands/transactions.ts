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
import {
  ACCOUNT_TRANSACTION_FIELDS,
  CARD_TRANSACTION_FIELDS,
  parseTransactions,
  type TransactionData,
} from "../transactions"

export type TransactionsResult =
  | { kind: "file"; path: string; bytes: number }
  | TransactionData
  | null

const datePattern = /^(\d{2})\.(\d{2})\.(\d{4})$/
const filenameRegex = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/
const defaultPageSize = 100
const pageLinkPattern = /(?:PageNumber|page)[=('/\s]+(\d+)/i
const bankPageLinkPattern =
  /SetFormFieldValueAndSubmitForm\([^,]+,\s*["']PageNumber["'],\s*["'](\d+)["']/
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
    : formatTab(result.tabRows)
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
    if (result.rows.length === 0) {
      console.error("No transactions found.")
      if (format === "tab") {
        return
      }
    }
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
      ? match[1].replace(/['"]/g, "").replaceAll("\\", "/")
      : `transactions_${accountId.replaceAll("/", "_")}_${dateFmt(new Date())}.${format}`
  )
  const downloads = path.join(process.cwd(), "downloads")
  fs.mkdirSync(downloads, { recursive: true })
  return saveFile(path.join(downloads, filename), res.body, validate)
}

function parsePage(
  res: HttpResponse,
  account: boolean,
  currentPage: number,
  requestedPageSize: number,
  expectedAccountId: string
) {
  const $ = load(res.body.toString("utf-8"))
  const accountTitle = $(".widget-title").first()
  const returnedAccount = accountTitle.find("strong").first().text().trim()
  if (
    account &&
    accountTitle.length > 0 &&
    returnedAccount !== expectedAccountId
  ) {
    throw bankResponseError(
      "NLB returned transactions for a different account. The requested account type may not be supported."
    )
  }
  const parsed = parseTransactions(res, account ? "account" : "card")
  return { ...parsed, ...pagination($, currentPage, requestedPageSize) }
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
      const bankPage = link.attr("onclick")?.match(bankPageLinkPattern)
      // The bank's form values are zero-based; page labels are one-based.
      if (bankPage) {
        return Number(bankPage[1]) + 1
      }
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
    PageNumber: endpoint === "/Retail/Transactions" ? "0" : "1",
  }
  if (["xls", "pdf"].includes(format)) {
    request.Report = format === "xls" ? "Excel" : "Pdf"
    const res = await nlbPost(endpoint, cookie, request)
    return exportReport(res, format, data.AccountID, output)
  }

  const rows: string[][] = []
  const tabRows: string[][] = []
  const jsonRows: TransactionData["jsonRows"] = []
  const headers = [
    ...(endpoint === "/Retail/Transactions"
      ? ACCOUNT_TRANSACTION_FIELDS
      : CARD_TRANSACTION_FIELDS),
  ]
  const seen = new Set<string>()
  for (let page = 1; ; page++) {
    request.PageNumber = String(
      endpoint === "/Retail/Transactions" ? page - 1 : page
    )
    const res = await nlbPost(endpoint, cookie, request)
    validateExportResponse(res)
    const parsed = parsePage(
      res,
      endpoint === "/Retail/Transactions",
      page,
      Number(request.PageSize),
      data.AccountID
    )
    if (parsed.rows.length === 0) {
      break
    }
    const signature = JSON.stringify(parsed.tabRows)
    if (seen.has(signature)) {
      throw bankResponseError(
        "NLB repeated a transaction page; export is incomplete."
      )
    }
    seen.add(signature)
    rows.push(...parsed.rows)
    tabRows.push(...parsed.tabRows)
    jsonRows.push(...parsed.jsonRows)
    if (
      parsed.nextDisabled ||
      (!parsed.hasNext && parsed.rows.length < parsed.pageSize)
    ) {
      break
    }
  }
  const result = { kind: "data" as const, headers, rows, tabRows, jsonRows }
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
  return result
}
