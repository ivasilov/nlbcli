import fs from "node:fs"
import path from "node:path"
// biome-ignore lint/performance/noNamespaceImport: <explanation>
import * as cheerio from "cheerio"
import { dateFmt } from "../constants"
import { nlbGet, nlbPost } from "../http"

export async function cmdListAccounts(cookie: string): Promise<string[]> {
  const res = await nlbGet("/Home/Balances?bankid=tutunska.banka@ibank", cookie)
  const html = res.body.toString("utf-8")
  return [
    ...new Set(html.match(/[0-9]{3}-[0-9]{10}-[0-9]{2}[A-Z]{2,3}/g) || []),
  ]
}

export async function cmdAccountBalance(
  cookie: string,
  accountId: string
): Promise<Record<string, string> | null> {
  const res = await nlbPost("/Retail/Account", cookie, {
    ignoreSettingContextAccount: "False",
    SaveFilter: "False",
    RemoveFilter: "False",
    PageNumber: "",
    PageSize: "",
    DetailsView: "0",
    SelectedItem: "",
    PageId: "",
    IsWidget: "False",
    AccountID: accountId,
    Report: "",
    "X-Requested-With": "XMLHttpRequest",
  })

  const $ = cheerio.load(res.body.toString("utf-8"))
  const cells = $(".dps-content")
    .map((_i, el) => $(el).text().trim())
    .get()

  if (cells.length === 0) {
    return null
  }

  return {
    "account-id": accountId,
    "account-owner": cells[0] || "",
    "account-status": cells[1] || "",
    "current-balance": cells[3] || "",
    "available-balance": cells[5] || "",
    "allowed-overdraft": cells[7] || "",
    "reserved-funds": cells[9] || "",
    "last-change": cells[13] || "",
    "last-interest": cells[15] || "",
  }
}

export type TransactionsResult =
  | { kind: "file"; path: string; bytes: number }
  | {
      kind: "data"
      headers: string[]
      rows: string[][]
      jsonRows: Record<string, string>[]
    }
  | null

const filenameRegex = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/
export async function cmdAccountTransactions(
  cookie: string,
  accountId: string,
  startDate: string,
  endDate: string,
  format: string,
  direction: string,
  name: string
): Promise<TransactionsResult> {
  const directionMap: Record<string, string> = { in: "1", out: "-1" }

  const data: Record<string, string> = {
    ignoreSettingContextAccount: "False",
    SaveFilter: "False",
    RemoveFilter: "False",
    PageNumber: "",
    PageSize: "100",
    DetailsView: "0",
    SelectedItem: "",
    PageId: "",
    IsWidget: "False",
    AccountID: accountId,
    DateFrom: startDate,
    DateTo: endDate,
    Direction: directionMap[direction] || "0",
    AmountCondition: "",
    AmountFrom: "",
    Amount: "",
    AmountTo: "",
    OtherPartyName: name,
    OtherPartyAccount: "",
    TransactionsForPrint: "",
    SortColumn: "Date",
    SortDirection: "DESC",
    Report: "",
    "X-Requested-With": "XMLHttpRequest",
  }

  // File export formats
  if (["xls", "pdf"].includes(format)) {
    data.Report = format === "xls" ? "Excel" : "Pdf"
    const res = await nlbPost("/Retail/Transactions", cookie, data)
    const disposition = (res.headers["content-disposition"] as string) || ""
    const match = disposition.match(filenameRegex)
    const ext = format === "pdf" ? "pdf" : "xls"
    const filename = match
      ? match[1].replace(/['"]/g, "")
      : `transactions_${accountId}_${dateFmt(new Date())}.${ext}`

    const downloadsDir = path.join(process.cwd(), "downloads")
    if (!fs.existsSync(downloadsDir)) {
      fs.mkdirSync(downloadsDir, { recursive: true })
    }
    const savePath = path.join(downloadsDir, filename)
    fs.writeFileSync(savePath, res.body)
    return { kind: "file", path: savePath, bytes: res.body.length }
  }

  // Text output formats (tab, csv, json)
  const res = await nlbPost("/Retail/Transactions", cookie, data)
  const $ = cheerio.load(res.body.toString("utf-8"))
  const headers = [
    "date",
    "recipient",
    "description",
    "status",
    "amount",
    "fee",
    "balance",
  ]
  const rows: string[][] = []
  const jsonRows: Record<string, string>[] = []

  $("tbody > tr").each((_i, tr) => {
    const tds = $(tr).find("td").slice(1)
    const vals = tds.map((_j, td) => $(td).text().trim()).get()
    if (vals.length >= 7) {
      rows.push(vals.slice(0, 7))
      jsonRows.push(Object.fromEntries(headers.map((h, idx) => [h, vals[idx]])))
    }
  })

  if (rows.length === 0) {
    return null
  }

  return { kind: "data", headers, rows, jsonRows }
}

export async function cmdAccountReservations(
  cookie: string,
  accountId: string
): Promise<string[][]> {
  const res = await nlbPost("/Retail/ReservationList", cookie, {
    ignoreSettingContextAccount: "False",
    SaveFilter: "False",
    RemoveFilter: "False",
    PageNumber: "",
    PageSize: "20",
    DetailsView: "0",
    SelectedItem: "",
    PageId: "",
    IsWidget: "False",
    AccountID: accountId,
    SortColumn: "Date",
    SortDirection: "DESC",
    Report: "",
    "X-Requested-With": "XMLHttpRequest",
  })

  const $ = cheerio.load(res.body.toString("utf-8"))
  const rows: string[][] = []
  $("tbody > tr").each((_i, tr) => {
    const tds = $(tr).find("td")
    rows.push(tds.map((_j, td) => $(td).text().trim()).get())
  })
  return rows
}
