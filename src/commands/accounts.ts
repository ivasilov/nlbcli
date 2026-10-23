import { load } from "cheerio"
import {
  nlbGet,
  nlbPost,
  requireBalancesPage,
  requireHtml,
  TABLE_HTML,
} from "../http"
import {
  fetchTransactions,
  type TransactionsResult,
  validateTransactionOptions,
} from "./transactions"

export async function cmdListAccounts(cookie: string): Promise<string[]> {
  const res = await nlbGet("/Home/Balances?bankid=tutunska.banka@ibank", cookie)
  const html = requireBalancesPage(res)
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

  const $ = load(requireHtml(res))
  const cells = $(".dps-content")
    .map((_i, el) => $(el).text().trim())
    .get()

  if (cells.length < 16) {
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

export type { TransactionsResult } from "./transactions"

export async function cmdAccountTransactions(
  cookie: string,
  accountId: string,
  startDate: string,
  endDate: string,
  format: string,
  direction: string,
  name: string,
  output?: string
): Promise<TransactionsResult> {
  validateTransactionOptions(startDate, endDate, format, output)
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

  return await fetchTransactions(
    cookie,
    "/Retail/Transactions",
    data,
    format,
    output
  )
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

  const $ = load(requireHtml(res, TABLE_HTML))
  const rows: string[][] = []
  $("tbody > tr").each((_i, tr) => {
    const tds = $(tr).find("td")
    rows.push(tds.map((_j, td) => $(td).text().trim()).get())
  })
  return rows
}
