import { load } from "cheerio"
import { nlbGet, nlbPost, requireBalancesPage, requireHtml } from "../http"
import {
  cardTransactionFormats,
  fetchTransactions,
  type TransactionsResult,
  validateTransactionOptions,
} from "./transactions"

export async function cmdListCards(cookie: string): Promise<string[]> {
  const res = await nlbGet("/Home/Balances?bankid=tutunska.banka@ibank", cookie)
  const html = requireBalancesPage(res)
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

  const $ = load(requireHtml(res))
  const cells = $(
    "#main_CmsAccountBalanceForm .col-lg-12 > .col-lg-8 > .row > div"
  )
    .map((_i, el) => $(el).text().trim())
    .get()

  if (cells.length < 19) {
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
  cardId: string,
  startDate: string,
  endDate: string,
  format: string,
  output?: string
): Promise<TransactionsResult> {
  validateTransactionOptions(
    startDate,
    endDate,
    format,
    output,
    cardTransactionFormats
  )
  return await fetchTransactions(
    cookie,
    "/Cms/Transactions",
    {
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
      DateFrom: startDate,
      DateTo: endDate,
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
    },
    format,
    output
  )
}
