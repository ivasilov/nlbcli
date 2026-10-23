import fs, { readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { parse } from "csv-parse/sync"
import { afterEach, describe, expect, test, vi } from "vitest"
import { cmdAccountTransactions } from "../src/commands/accounts"
import { printTransactionsResult } from "../src/commands/transactions"

const pagerPattern = /<ul class="pagination">[\s\S]*?<\/ul>/
const rowPattern = /<tr><td>[\s\S]*?<\/tr>/

function fixture(name: string): string {
  return readFileSync(
    new URL(`./fixtures/transactions/${name}.html`, import.meta.url),
    "utf8"
  )
}

function mockPages(...pages: { html: string; status?: number }[]) {
  const fetchMock = vi.fn()
  for (const { html, status = 200 } of pages) {
    fetchMock.mockResolvedValueOnce(new Response(html, { status }))
  }
  // Unexpected extra requests must fail rather than hit the network.
  fetchMock.mockRejectedValue(new Error("Unexpected page request"))
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

function retrieve(format: string, output?: string) {
  return cmdAccountTransactions(
    "session=redacted",
    "redacted-account",
    "01.10.2026",
    "23.10.2026",
    format,
    "out",
    "REDACTED",
    output
  )
}

function withoutPager(html: string) {
  return html.replace(pagerPattern, "")
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe.each(["csv", "json"])("%s transaction exports", (format) => {
  test("retrieves one page and preserves row values and order", async () => {
    const fetchMock = mockPages({ html: fixture("one-page") })
    const result = await retrieve(format)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result?.kind).toBe("data")
    if (result?.kind !== "data") {
      throw new Error("Expected transaction data")
    }
    expect(result.rows).toHaveLength(3)
    expect(result.rows.map((row) => row[2])).toEqual([
      'Redacted, "quoted" transfer 001',
      "Redacted transfer 002",
      "Redacted transfer 003",
    ])
    expect(result.jsonRows[0]).toEqual({
      date: "2026-10-23",
      recipient: "REDACTED",
      description: 'Redacted, "quoted" transfer 001',
      status: "Completed",
      amount: "-1.00",
      fee: "0.00",
      balance: "0.00",
    })
  })

  test("retrieves every page with unchanged filters and bank ordering", async () => {
    const fetchMock = mockPages(
      { html: fixture("page-1") },
      { html: fixture("page-2") },
      { html: fixture("page-3") }
    )
    const result = await retrieve(format)

    expect(result?.kind).toBe("data")
    if (result?.kind !== "data") {
      throw new Error("Expected transaction data")
    }
    expect(result.rows).toHaveLength(202)
    // Every date is equal, so this also guards against sorting or reversing rows.
    expect(result.rows.map((row) => row[2].slice(-3))).toEqual(
      Array.from({ length: 202 }, (_, index) =>
        String(index + 1).padStart(3, "0")
      )
    )
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const requests = fetchMock.mock.calls.map(([url, options]) => {
      expect(url.pathname).toBe("/Retail/Transactions")
      expect(options.headers.Cookie).toBe("session=redacted")
      return Object.fromEntries(new URLSearchParams(options.body))
    })
    expect(requests.map((request) => request.PageNumber)).toEqual([
      "1",
      "2",
      "3",
    ])
    for (const request of requests) {
      expect(request).toEqual({
        ...requests[0],
        PageNumber: request.PageNumber,
      })
      expect(request).toMatchObject({
        PageSize: "100",
        AccountID: "redacted-account",
        DateFrom: "01.10.2026",
        DateTo: "23.10.2026",
        Direction: "-1",
        OtherPartyName: "REDACTED",
        SortColumn: "Date",
        SortDirection: "DESC",
        Report: "",
      })
    }

    const output = vi.spyOn(console, "log").mockImplementation(() => undefined)
    printTransactionsResult(result, format)
    expect(output).toHaveBeenCalledTimes(1)
    const content = output.mock.calls[0][0]
    if (format === "json") {
      const exported = JSON.parse(content)
      expect(exported).toHaveLength(202)
      expect(exported[201].description).toBe("Redacted transfer 202")
    } else {
      const exported = parse(content)
      expect(exported).toHaveLength(203)
      expect(exported[1][2]).toBe('Redacted, "quoted" transfer 001')
      expect(exported[202][2]).toBe("Redacted transfer 202")
    }
  })

  test("handles an empty result without requesting another page", async () => {
    const fetchMock = mockPages({ html: fixture("empty") })
    await expect(retrieve(format)).resolves.toMatchObject({
      kind: "data",
      rows: [],
      jsonRows: [],
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("rejects a repeated page even when its page number advances", async () => {
    const fetchMock = mockPages(
      { html: fixture("page-1") },
      { html: fixture("repeated-page") }
    )
    await expect(retrieve(format)).rejects.toThrow(
      "page 2 repeats an earlier page"
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test("rejects a failure partway through retrieval without returning staged rows", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined)
    const fetchMock = mockPages(
      { html: fixture("page-1") },
      { html: fixture("failed-page"), status: 503 }
    )
    await expect(retrieve(format)).rejects.toThrow(
      "Could not retrieve transaction page 2; no transactions were exported. NLB returned an invalid response (HTTP 503)."
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(output).not.toHaveBeenCalled()
  })
})

test("keeps the result pending until the final page succeeds", async () => {
  let finishPage: (response: Response) => void = () => undefined
  const pendingPage = new Promise<Response>((resolve) => {
    finishPage = resolve
  })
  const fetchMock = mockPages()
  fetchMock.mockImplementationOnce(async () => new Response(fixture("page-1")))
  fetchMock.mockImplementationOnce(async () => new Response(fixture("page-2")))
  fetchMock.mockImplementationOnce(() => pendingPage)
  const settled = vi.fn()
  const result = retrieve("json").then((value) => {
    settled()
    return value
  })
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
  expect(settled).not.toHaveBeenCalled()
  finishPage(new Response(fixture("page-3")))
  expect((await result)?.kind).toBe("data")
  expect(settled).toHaveBeenCalledTimes(1)
})

test("probes past a full page when pagination controls are absent", async () => {
  const fetchMock = mockPages(
    { html: withoutPager(fixture("page-1")) },
    { html: withoutPager(fixture("page-2")) },
    { html: withoutPager(fixture("page-3")) }
  )
  const result = await retrieve("csv")
  expect(fetchMock).toHaveBeenCalledTimes(3)
  expect(result?.kind === "data" && result.rows.length).toBe(202)
})

test("accepts an empty probe after an exact multiple of the page size", async () => {
  const fetchMock = mockPages(
    { html: withoutPager(fixture("page-1")) },
    {
      html: withoutPager(fixture("empty")).replace(
        'name="PageNumber" value="1"',
        'name="PageNumber" value="2"'
      ),
    }
  )
  const result = await retrieve("json")
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(result?.kind === "data" && result.rows.length).toBe(100)
})

test("does not probe beyond a full page with an explicit final-page pager", async () => {
  const pager = fixture("one-page").match(pagerPattern)?.[0] || ""
  const fetchMock = mockPages({
    html: fixture("page-1").replace(pagerPattern, pager),
  })
  const result = await retrieve("csv")
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(result?.kind === "data" && result.rows.length).toBe(100)
})

test("rejects repeated full pages when pagination metadata is absent", async () => {
  mockPages(
    { html: withoutPager(fixture("page-1")) },
    { html: withoutPager(fixture("repeated-page")) }
  )
  await expect(retrieve("csv")).rejects.toThrow(
    "page 2 repeats an earlier page"
  )
})

test.each([
  ["wrong page number", "page-1", "received another page"],
  ["unexpected HTML", "failed-page", "valid transactions table"],
])("rejects %s", async (_description, pageFixture, message) => {
  mockPages({ html: fixture("page-1") }, { html: fixture(pageFixture) })
  await expect(retrieve("json")).rejects.toThrow(message)
})

test("rejects an empty page before the advertised end", async () => {
  mockPages(
    { html: fixture("page-1") },
    {
      html: withoutPager(fixture("empty")).replace(
        'name="PageNumber" value="1"',
        'name="PageNumber" value="2"'
      ),
    }
  )
  await expect(retrieve("json")).rejects.toThrow("page 2 is empty")
})

test("rejects a short page that advertises more results", async () => {
  mockPages({ html: fixture("page-1").replace(rowPattern, "") })
  await expect(retrieve("json")).rejects.toThrow("page 1 is short")
})

test("rejects overlapping transaction identities across different pages", async () => {
  mockPages(
    { html: fixture("page-1") },
    { html: fixture("page-2").replace("redacted-101", "redacted-100") }
  )
  await expect(retrieve("csv")).rejects.toThrow("page 2 repeats a transaction")
})

test("rejects a network failure after the first page", async () => {
  const fetchMock = mockPages({ html: fixture("page-1") })
  fetchMock.mockRejectedValueOnce(new Error("Connection reset"))
  await expect(retrieve("json")).rejects.toThrow(
    "Could not retrieve transaction page 2; no transactions were exported. Unable to reach NLB."
  )
})

test.each([
  [
    "changed page size",
    fixture("one-page").replace(
      'name="PageSize" value="100"',
      'name="PageSize" value="20"'
    ),
    "changed the requested page size",
  ],
  [
    "unreadable page control",
    fixture("page-1").replace("'PageNumber', 2", "'Unknown', 2"),
    "page control could not be read",
  ],
  [
    "malformed transaction row",
    fixture("one-page").replace("<td>REDACTED</td>", ""),
    "valid transactions table",
  ],
  [
    "login page",
    '<form action="/Account/Login"><input type="password" /></form>',
    "No valid saved session",
  ],
])("rejects %s instead of an incomplete success", async (_name, html, message) => {
  mockPages({ html })
  await expect(retrieve("json")).rejects.toThrow(message)
})

test("rejects pagination that ends before an earlier advertised page", async () => {
  const lastPager =
    fixture("one-page")
      .match(pagerPattern)?.[0]
      .replace('href="#">1</a>', 'href="#">2</a>') || ""
  mockPages(
    { html: fixture("page-1") },
    { html: fixture("page-2").replace(pagerPattern, lastPager) }
  )
  await expect(retrieve("json")).rejects.toThrow(
    "page 2 ends before the previously advertised end"
  )
})

test("rejects a session redirect partway through retrieval", async () => {
  mockPages({ html: fixture("page-1") }, { html: "", status: 302 })
  await expect(retrieve("csv")).rejects.toThrow(
    "Could not retrieve transaction page 2; no transactions were exported. No valid saved session"
  )
})

test.each([
  "csv",
  "json",
])("keeps an existing %s file until every page succeeds", async (format) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nlbcli-pagination-"))
  const output = path.join(directory, `transactions.${format}`)
  try {
    fs.writeFileSync(output, "previous export")
    mockPages(
      { html: fixture("page-1") },
      { html: fixture("failed-page"), status: 503 }
    )
    await expect(retrieve(format, output)).rejects.toThrow("transaction page 2")
    expect(fs.readFileSync(output, "utf8")).toBe("previous export")
    expect(fs.readdirSync(directory)).toEqual([path.basename(output)])

    mockPages(
      { html: fixture("page-1") },
      { html: fixture("page-2") },
      { html: fixture("page-3") }
    )
    await expect(retrieve(format, output)).resolves.toMatchObject({
      kind: "file",
      path: output,
    })
    const contents = fs.readFileSync(output, "utf8")
    const rows =
      format === "json"
        ? JSON.parse(contents)
        : parse(contents, { columns: true })
    expect(rows).toHaveLength(202)
    expect(rows[201].description).toBe("Redacted transfer 202")
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("preserves support for page totals without navigation links", async () => {
  mockPages(
    ...["page-1", "page-2", "page-3"].map((name) => ({
      html: `${withoutPager(fixture(name))}<input name="TotalPages" value="3">`,
    }))
  )
  const result = await retrieve("json")
  expect(result?.kind === "data" && result.rows.length).toBe(202)
})

test("rejects page totals that change during retrieval", async () => {
  mockPages(
    { html: `${fixture("page-1")}<input name="TotalPages" value="3">` },
    { html: `${fixture("page-2")}<input name="TotalPages" value="4">` }
  )
  await expect(retrieve("json")).rejects.toThrow("page total changed")
})

test("preserves support for pager navigation", async () => {
  mockPages(
    ...["page-1", "page-2", "page-3"].map((name) => ({
      html: fixture(name).replace('class="pagination"', 'class="pager"'),
    }))
  )
  const result = await retrieve("csv")
  expect(result?.kind === "data" && result.rows.length).toBe(202)
})
