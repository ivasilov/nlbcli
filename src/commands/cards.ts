// biome-ignore lint/performance/noNamespaceImport: Cheerio's namespace API is used throughout this parser
import * as cheerio from "cheerio"
import { dateFmt } from "../constants"
import { nlbGet, nlbPost } from "../http"

export async function cmdListCards(cookie: string): Promise<string[]> {
  const res = await nlbGet("/Home/Balances?bankid=tutunska.banka@ibank", cookie)
  const html = res.body.toString("utf-8")
  return [...new Set(html.match(/[0-9]{8,15}\/[0-9]{4}/g) || [])]
}

export async function cmdCardBalance(
  cookie: string,
  cardId: string
): Promise<Record<string, string> | null> {
  const res = await nlbPost("/Cms/Account", cookie, {
    ignoreSettingContextAccount: "False",
    SaveFilter: "False",
    RemoveFilter: "False",
    PageNumber: "",
    PageSize: "",
    DetailsView: "0",
    SelectedItem: "",
    PageId: "",
    IsWidget: "False",
    AccountID: cardId,
    Report: "",
    "X-Requested-With": "XMLHttpRequest",
  })

  const $ = cheerio.load(res.body.toString("utf-8"))
  const cells = $(
    "#main_CmsAccountBalanceForm .col-lg-12 > .col-lg-8 > .row > div"
  )
    .map((_i, el) => $(el).text().trim())
    .get()

  if (cells.length === 0) {
    return null
  }

  return {
    "card-id": cardId,
    "current-balance": cells[1] || "",
    "available-balance": cells[4] || "",
    "reserved-funds": cells[7] || "",
    "amount-to-pay": cells[10] || "",
    "current-limit": cells[12] || "",
    "card-type": cells[14] || "",
    "card-number": cells[16] || "",
    "credit-debit": cells[18] || "",
  }
}

export async function cmdCardTransactions(
  cookie: string,
  cardId: string
): Promise<string[][]> {
  const today = new Date()
  const monthAgo = new Date(today)
  monthAgo.setDate(monthAgo.getDate() - 30)

  const res = await nlbPost("/Cms/Transactions", cookie, {
    ignoreSettingContextAccount: "False",
    SaveFilter: "False",
    RemoveFilter: "False",
    PageNumber: "",
    PageSize: "20",
    DetailsView: "0",
    SelectedItem: "",
    PageId: "",
    IsWidget: "False",
    AccountID: cardId,
    DateFrom: dateFmt(monthAgo),
    DateTo: dateFmt(today),
    CardNumber: "",
    AmountCondition: "",
    AmountFrom: "",
    Amount: "",
    AmountTo: "",
    TrnDescription: "",
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
