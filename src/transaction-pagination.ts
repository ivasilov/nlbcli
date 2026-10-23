import type { load } from "cheerio"
import { bankResponseError, CliError } from "./errors"
import { validateExportResponse } from "./exports"
import { type HttpResponse, nlbPost } from "./http"
import {
  ACCOUNT_TRANSACTION_FIELDS,
  parseTransactions,
  requireBankPage,
  type TransactionData,
} from "./transactions"

const PAGE_SIZE = 100
const MAX_PAGES = 10_000
const integerPattern = /^\d+$/
const pageFieldPattern =
  /SetFormFieldValueAndSubmitForm\(\s*['"][^'"]+['"]\s*,\s*['"]PageNumber['"]\s*,\s*['"]?(\d+)['"]?\s*\)/
const pageQueryPattern = /[?&](?:PageNumber|page)=(\d+)(?:&|$)/i

function paginationError(message: string): never {
  throw bankResponseError(
    `Inconsistent transaction pagination: ${message} No transactions were exported.`
  )
}

function pageNumber(value: string): number {
  const number = Number(value)
  if (
    !(integerPattern.test(value) && Number.isSafeInteger(number) && number > 0)
  ) {
    return paginationError("invalid page number.")
  }
  return number
}

function validateCurrentPage(
  $: ReturnType<typeof load>,
  requestedPage: number
) {
  const currentPages: number[] = []
  const pageFields = $('input[name="PageNumber"]')
  for (const field of pageFields) {
    const value = $(field).attr("value")?.trim()
    if (value) {
      currentPages.push(pageNumber(value))
    }
  }
  for (const active of $(".pagination .active, .pager .active")) {
    currentPages.push(pageNumber($(active).text().trim()))
  }
  if (currentPages.some((page) => page !== requestedPage)) {
    paginationError(
      `requested page ${requestedPage}, but received another page.`
    )
  }

  for (const field of $('input[name="PageSize"], select[name="PageSize"]')) {
    if (Number($(field).val()) !== PAGE_SIZE) {
      paginationError("the bank changed the requested page size.")
    }
  }
}

function readPageTargets($: ReturnType<typeof load>, requestedPage: number) {
  const targets: number[] = []
  const controls = $(
    ".pagination a, .pager a, .pagination button, [data-page], [data-page-number], [rel=next]"
  )
  for (const link of controls) {
    const element = $(link)
    if (
      element.closest(".disabled, .active, [disabled], [aria-disabled=true]")
        .length
    ) {
      continue
    }
    const onclick = element.attr("onclick") || ""
    const href = element.attr("href") || ""
    const match =
      onclick.match(pageFieldPattern) || href.match(pageQueryPattern)
    const numericLabel =
      !onclick && integerPattern.test(element.text().trim())
        ? element.text().trim()
        : undefined
    const target =
      element.attr("data-page") ||
      element.attr("data-page-number") ||
      match?.[1] ||
      numericLabel
    if (target) {
      targets.push(pageNumber(target))
    } else if (
      element.closest(".next, .PagedList-skipToNext, [rel=next]").length
    ) {
      targets.push(requestedPage + 1)
    } else {
      paginationError("an enabled page control could not be read.")
    }
  }

  return targets
}

function readPagination($: ReturnType<typeof load>, requestedPage: number) {
  validateCurrentPage($, requestedPage)
  const targets = readPageTargets($, requestedPage)
  const next = $(
    ".pagination .next, .pager .next, .PagedList-skipToNext, [rel=next]"
  )
  const nextDisabled =
    next.length > 0 &&
    next
      .toArray()
      .every(
        (el) =>
          $(el).closest(".disabled, [disabled], [aria-disabled=true]").length >
          0
      )
  const totals = $('[name="TotalPages"], [name="PageCount"]')
    .map((_i, el) => {
      const value = String($(el).val() ?? "").trim()
      return value === "0" ? 0 : pageNumber(value)
    })
    .get()
  if (totals.some((total) => total !== totals[0])) {
    paginationError("conflicting page totals.")
  }
  const totalPages = totals[0]
  const highestPage = Math.max(requestedPage, ...targets, totalPages ?? 0)
  if (totalPages !== undefined && totalPages > 0 && highestPage > totalPages) {
    paginationError("page controls exceed the advertised page total.")
  }
  if (nextDisabled && highestPage > requestedPage) {
    paginationError("the next page is disabled before the advertised end.")
  }
  return {
    // With no readable pager, a full page requires a probe for the next page.
    hasPager:
      $(
        ".pagination .active, .pagination .disabled, .pager .active, .pager .disabled"
      ).length > 0 ||
      targets.length > 0 ||
      nextDisabled ||
      totalPages !== undefined,
    hasDeclaredSize:
      $('input[name="PageSize"], select[name="PageSize"]').length > 0,
    highestPage,
    totalPages,
  }
}

function parsePage(res: HttpResponse, requestedPage: number) {
  const parsed = parseTransactions(res, "account")
  const $ = requireBankPage(res)
  // Only use checkbox identities from an unambiguous transaction table.
  // The shared parser can also select a named table among layout tables.
  const bodies = $("table > tbody")
  const ids =
    bodies.length === 1
      ? bodies
          .find("tr > td:first-child input[value]")
          .map((_i, input) => $(input).attr("value") || "")
          .get()
          .filter(Boolean)
      : []
  if (parsed.rows.length > PAGE_SIZE) {
    paginationError("a page contains more rows than requested.")
  }
  return { ...parsed, ids, ...readPagination($, requestedPage) }
}

type TransactionPage = ReturnType<typeof parsePage>

async function requestPage(
  cookie: string,
  data: Record<string, string>,
  page: number
): Promise<TransactionPage> {
  try {
    const res = await nlbPost("/Retail/Transactions", cookie, {
      ...data,
      PageNumber: String(page),
      PageSize: String(PAGE_SIZE),
    })
    validateExportResponse(res)
    return parsePage(res, page)
  } catch (cause) {
    const message = `Could not retrieve transaction page ${page}; no transactions were exported. ${cause instanceof Error ? cause.message : "Request failed."}`
    throw cause instanceof CliError
      ? new CliError(cause.exitCode, message)
      : bankResponseError(message)
  }
}

function hasMorePages(
  parsed: TransactionPage,
  page: number,
  previouslyAdvertisedPage: number
) {
  if (
    parsed.rows.length === 0 &&
    page <= previouslyAdvertisedPage &&
    page > 1
  ) {
    paginationError(`page ${page} is empty before the advertised end.`)
  }
  const highestPage = Math.max(previouslyAdvertisedPage, parsed.highestPage)
  if (highestPage > page) {
    if (
      parsed.rows.length === 0 ||
      (parsed.rows.length !== PAGE_SIZE &&
        (parsed.hasDeclaredSize || !parsed.hasPager))
    ) {
      paginationError(`page ${page} is short before the advertised end.`)
    }
    if (parsed.hasPager && parsed.highestPage === page) {
      paginationError(`page ${page} ends before the previously advertised end.`)
    }
    return true
  }
  return !parsed.hasPager && parsed.rows.length === PAGE_SIZE
}

function validatePageTotal(
  previous: number | undefined,
  parsed: TransactionPage
) {
  const total = parsed.totalPages
  if (total === undefined) {
    return previous
  }
  if (previous !== undefined && previous !== total) {
    paginationError("the advertised page total changed during retrieval.")
  }
  if (total === 0 && parsed.rows.length > 0) {
    paginationError("transactions were returned with a zero page total.")
  }
  return total
}

/** Stage every page before exposing any rows to the output formatters. */
export async function retrieveAccountTransactions(
  cookie: string,
  data: Record<string, string>
): Promise<TransactionData> {
  const result: TransactionData = {
    kind: "data",
    headers: [...ACCOUNT_TRANSACTION_FIELDS],
    rows: [],
    tabRows: [],
    jsonRows: [],
  }
  const fingerprints = new Set<string>()
  const transactionIds = new Set<string>()
  let highestPage = 1
  let totalPages: number | undefined

  for (let page = 1; page <= MAX_PAGES; page++) {
    const parsed = await requestPage(cookie, data, page)
    totalPages = validatePageTotal(totalPages, parsed)
    const morePages = hasMorePages(parsed, page, highestPage)
    highestPage = Math.max(highestPage, parsed.highestPage)
    const fingerprint = JSON.stringify(parsed.tabRows)
    if (parsed.rows.length > 0 && fingerprints.has(fingerprint)) {
      paginationError(`page ${page} repeats an earlier page.`)
    }
    fingerprints.add(fingerprint)
    for (const id of parsed.ids) {
      if (transactionIds.has(id)) {
        paginationError(`page ${page} repeats a transaction.`)
      }
      transactionIds.add(id)
    }
    result.rows.push(...parsed.rows)
    result.tabRows.push(...parsed.tabRows)
    result.jsonRows.push(...parsed.jsonRows)
    if (!morePages) {
      return result
    }
  }
  return paginationError("the page limit was exceeded.")
}
