import { load } from "cheerio"
import { bankResponseError } from "./errors"
import { type HttpResponse, requireHtml } from "./http"

export const ACCOUNT_TRANSACTION_FIELDS = [
  "date",
  "recipient",
  "description",
  "status",
  "amount",
  "fee",
  "balance",
] as const

export const CARD_TRANSACTION_FIELDS = [
  "date",
  "description",
  "amount",
  "currency",
] as const

export type TransactionValue = string | null
export type TransactionRow = Record<string, TransactionValue>
export interface TransactionData {
  headers: string[]
  jsonRows: TransactionRow[]
  kind: "data"
  rows: string[][]
  tabRows: string[][]
}

const bankDate = /^(\d{1,2})\.(\d{1,2})\.(\d{4})\.?$/
const isoDate = /^(\d{4})-(\d{2})-(\d{2})$/

/** Parse calendar components, never the host's date parser or timezone. */
export function normalizeDate(value: string): string | null {
  const text = value.trim()
  if (!text || text === "-") {
    return null
  }
  const local = bankDate.exec(text)
  const iso = isoDate.exec(text)
  const year = local?.[3] ?? iso?.[1]
  const month = local?.[2] ?? iso?.[2]
  const day = local?.[1] ?? iso?.[3]
  if (!(year && month && day)) {
    throw bankResponseError("Invalid transaction date")
  }
  const y = Number(year)
  const m = Number(month)
  const d = Number(day)
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > days[m - 1]) {
    throw bankResponseError("Invalid transaction date")
  }
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`
}

const bankAmount = /^[+-]?(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d+)?$/
const englishAmount = /^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)\.\d+$/
const groupedInteger = /^[+-]?\d{1,3}(?:\.\d{3})+$/
const leadingSign = /^[+-]/
const redundantZeros = /^0+(?=\d)/
const nonzeroDigit = /[1-9]/
const currencyCode = /^[A-Z]{3}$/

/** Normalize bank decimal-comma and decimal-point amounts without Number. */
export function normalizeAmount(value: string): string | null {
  const text = value.trim().replace(/\u2212/g, "-")
  if (!text || text === "-") {
    return null
  }
  if (englishAmount.test(text) && !groupedInteger.test(text)) {
    return canonicalDecimal(text.replaceAll(",", ""))
  }
  if (!bankAmount.test(text)) {
    throw bankResponseError("Invalid transaction amount")
  }
  return canonicalDecimal(text.replaceAll(".", "").replace(",", "."))
}

function canonicalDecimal(text: string): string {
  const unsigned = text.replace(leadingSign, "")
  const [integer, fraction] = unsigned.split(".")
  const digits = integer.replace(redundantZeros, "")
  const negative = text.startsWith("-") && nonzeroDigit.test(unsigned)
  return `${negative ? "-" : ""}${digits}${fraction === undefined ? "" : `.${fraction}`}`
}

export function requireBankPage(res: HttpResponse): ReturnType<typeof load> {
  const $ = load(requireHtml(res), { sourceCodeLocationInfo: true })
  // Cheerio repairs incomplete documents; require explicit closing tags.
  for (const element of $("html, body").toArray()) {
    const location = element.sourceCodeLocation
    if (location?.startTag && !location.endTag) {
      throw invalidTable("Incomplete document")
    }
  }
  return $
}

function invalidTable(reason: string): Error {
  return bankResponseError(
    `NLB did not return a valid transactions table (${reason}; incomplete transaction table or document).`
  )
}

const aliases: Record<string, string> = {
  date: "date",
  датум: "date",
  recipient: "recipient",
  otherpartyname: "recipient",
  примач: "recipient",
  назив: "recipient",
  description: "description",
  trndescription: "description",
  опис: "description",
  status: "status",
  статус: "status",
  amount: "amount",
  износ: "amount",
  fee: "fee",
  провизија: "fee",
  balance: "balance",
  салдо: "balance",
  currency: "currency",
  валута: "currency",
}

function headerField(value: string): string | undefined {
  return aliases[value.trim().toLowerCase()]
}

function normalizeField(field: string, value: string): TransactionValue {
  if (field === "date") {
    return normalizeDate(value)
  }
  if (["amount", "fee", "balance"].includes(field)) {
    return normalizeAmount(value)
  }
  const text = value.trim()
  if (!text) {
    return null
  }
  if (field === "currency") {
    const currency = text.toUpperCase()
    if (!currencyCode.test(currency)) {
      throw bankResponseError("Invalid transaction currency")
    }
    return currency
  }
  return text
}

export function parseTransactions(
  res: HttpResponse,
  kind: "account" | "card"
): TransactionData {
  const $ = requireBankPage(res)
  const fields =
    kind === "account" ? ACCOUNT_TRANSACTION_FIELDS : CARD_TRANSACTION_FIELDS
  const tables = $("table")
  const namedTables = tables.filter((_i, table) => {
    const headers = $(table).find("thead th")
    const names = headers
      .map(
        (_j, th) => headerField($(th).attr("data-sort") ?? $(th).text()) ?? ""
      )
      .get()
    return names.includes("date") && names.includes("amount")
  })
  // Preserve the existing account layout even when its headings are unknown.
  // Prefer named tables so unrelated layout tables do not become candidates.
  const candidates = namedTables.length
    ? namedTables
    : tables.filter((_i, table) => {
        const firstRow = $(table).find("tbody > tr").first()
        const cells = firstRow.children("td")
        const empty =
          $(table).children("tbody").length === 1 &&
          (!firstRow.length ||
            ($(table).find("tbody > tr").length === 1 &&
              cells.length === 1 &&
              cells.is("[colspan]")))
        return (
          empty ||
          (kind === "account" &&
            cells.length === ACCOUNT_TRANSACTION_FIELDS.length + 1)
        )
      })
  if (candidates.length !== 1) {
    throw invalidTable("Unrecognized NLB transaction table")
  }
  const table = candidates.first()
  if (
    table.children("tbody").length !== 1 ||
    !table.get(0)?.sourceCodeLocation?.endTag
  ) {
    throw invalidTable("Malformed NLB transaction table")
  }
  const headerCells = table.find("thead th")
  const columns = namedTables.length
    ? headerCells
        .map(
          (_i, th) => headerField($(th).attr("data-sort") ?? $(th).text()) ?? ""
        )
        .get()
    : []
  if (
    columns.filter(Boolean).length !== new Set(columns.filter(Boolean)).size
  ) {
    throw invalidTable("Duplicate NLB transaction columns")
  }
  const indexes = fields.map((field, i) =>
    columns.length ? columns.indexOf(field) : i + 1
  )
  const jsonRows: TransactionRow[] = []
  const tabRows: string[][] = []
  table.find("tbody > tr").each((_i, tr) => {
    if (!tr.sourceCodeLocation?.endTag) {
      throw invalidTable("Malformed NLB transaction row")
    }
    const cells = $(tr).children("td")
    if (
      cells.length === 1 &&
      cells.first().attr("colspan") &&
      table.find("tbody > tr").length === 1
    ) {
      return
    }
    const expected = columns.length || ACCOUNT_TRANSACTION_FIELDS.length + 1
    if (
      cells.length !== expected ||
      cells.filter("[colspan], [rowspan]").length
    ) {
      throw invalidTable("Malformed NLB transaction row")
    }
    const values = cells.map((_j, td) => $(td).text().trim()).get()
    const row: TransactionRow = {}
    for (const [i, field] of fields.entries()) {
      row[field] = normalizeField(
        field,
        indexes[i] < 0 ? "" : values[indexes[i]]
      )
    }
    jsonRows.push(row)
    tabRows.push(
      kind === "account"
        ? indexes.map((index) => (index < 0 ? "" : values[index]))
        : values
    )
  })
  return {
    kind: "data",
    headers: [...fields],
    rows: jsonRows.map((row) => fields.map((field) => row[field] ?? "")),
    tabRows,
    jsonRows,
  }
}
