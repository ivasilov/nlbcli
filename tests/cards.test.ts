import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { cmdCardTransactions } from "../src/commands/cards"
import { transactionDates } from "../src/commands/transactions"
import { EXIT_CODES } from "../src/errors"

const pagerPattern = /<ul[\s\S]*<\/ul>/
const tbodyPattern = /<tbody>[\s\S]*<\/tbody>/

const fixtures = new URL("./fixtures/cards/", import.meta.url)
const page1 = fs.readFileSync(new URL("page-1.html", fixtures), "utf-8")
const page2 = fs.readFileSync(new URL("page-2.html", fixtures), "utf-8")
const live = fs.readFileSync(
  new URL("live-transactions.html", fixtures),
  "utf-8"
)
const empty = fs.readFileSync(new URL("empty.html", fixtures), "utf-8")
const report = fs.readFileSync(new URL("report.xls", fixtures))
const login = fs.readFileSync(
  new URL("./fixtures/login.html", import.meta.url),
  "utf-8"
)
const cookie = "session=REDACTED"
const card = "00000000/0000"
const start = "01.01.2024"
const end = "31.01.2024"
let directory: string
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>

function html(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html" },
  })
}

function exportCards(format = "json", output?: string) {
  return cmdCardTransactions(cookie, card, start, end, format, output)
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "nlbcli-cards-"))
  fetchMock = vi.fn<typeof fetch>()
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  fs.rmSync(directory, { recursive: true, force: true })
})

describe("card transaction exports", () => {
  test("exports every live-layout page with the bank's zero-based pager", async () => {
    const first = `${live}<ul class="pagination"><li class="active"><a>1</a></li><li><a onclick="iBank.Forms.SetFormFieldValueAndSubmitForm('CmsTransactionsForm', 'PageNumber', '1');">2</a></li></ul>`
    const last = `${live.replace("REDACTED SHOP", "REDACTED SECOND SHOP")}<ul class="pagination"><li><a onclick="iBank.Forms.SetFormFieldValueAndSubmitForm('CmsTransactionsForm', 'PageNumber', '0');">1</a></li><li class="active"><a>2</a></li></ul>`
    fetchMock.mockImplementation((_url, options) => {
      const fields = new URLSearchParams(String(options?.body))
      return Promise.resolve(
        html(fields.get("PageNumber") === "0" ? first : last)
      )
    })
    const output = path.join(directory, "live.csv")
    await exportCards("csv", output)
    expect(fs.readFileSync(output, "utf-8")).toBe(
      "date,description,amount,currency\n2024-01-31,REDACTED SHOP,12.34,EUR\n2024-01-31,REDACTED SECOND SHOP,12.34,EUR\n"
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(
      fetchMock.mock.calls.map(([, options]) =>
        new URLSearchParams(String(options?.body)).get("PageNumber")
      )
    ).toEqual(["0", "1"])
  })

  test.each([
    "tab",
    "csv",
    "json",
  ])("returns every page for %s with the requested bounds", async (format) => {
    fetchMock
      .mockResolvedValueOnce(html(page1))
      .mockResolvedValueOnce(html(page2))
    const result = await exportCards(format)
    expect(result).toMatchObject({
      kind: "data",
      headers: ["date", "description", "amount", "currency"],
    })
    if (result?.kind !== "data") {
      throw new Error("Expected parsed transactions")
    }
    expect(result.rows).toHaveLength(3)
    expect(result.rows[0][0]).toBe("2024-01-31")
    expect(result.rows[2][0]).toBe("2024-01-01")
    expect(result.jsonRows[0]).toEqual({
      date: "2024-01-31",
      description: 'REDACTED "SHOP", SKOPJE',
      amount: "-123.45",
      currency: "MKD",
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const [index, [url, options]] of fetchMock.mock.calls.entries()) {
      expect(String(url)).toBe("https://www.nlbklik.com.mk/Cms/Transactions")
      expect(options?.headers).toMatchObject({ Cookie: cookie })
      const fields = new URLSearchParams(String(options?.body))
      expect(Object.fromEntries(fields)).toMatchObject({
        AccountID: card,
        DateFrom: start,
        DateTo: end,
        PageNumber: String(index),
        PageSize: "20",
        Report: "",
      })
    }
  })

  test.each([
    "csv",
    "json",
    "tab",
  ])("writes %s to an explicit output path", async (format) => {
    fetchMock
      .mockResolvedValueOnce(html(page1))
      .mockResolvedValueOnce(html(page2))
    const output = path.join(directory, `card export.${format}`)
    const result = await exportCards(format, output)
    const content = fs.readFileSync(output, "utf-8")
    expect(result).toEqual({
      kind: "file",
      path: output,
      bytes: Buffer.byteLength(content),
    })
    if (format === "json") {
      expect(JSON.parse(content)).toHaveLength(3)
      expect(JSON.parse(content)[2].date).toBe("2024-01-01")
    } else if (format === "csv") {
      expect(content).toBe(
        'date,description,amount,currency\n2024-01-31,"REDACTED ""SHOP"", SKOPJE",-123.45,MKD\n2024-01-15,REDACTED REFUND,45.67,MKD\n2024-01-01,REDACTED MERCHANT,-89.01,MKD\n'
      )
    } else {
      expect(content).toContain(`${start}\tREDACTED MERCHANT\t-89.01\tMKD\n`)
    }
  })

  test("downloads XLS with the requested date range and path", async () => {
    fetchMock.mockResolvedValueOnce(html(page1))
    fetchMock.mockResolvedValueOnce(
      new Response(report, {
        headers: { "content-type": "application/vnd.ms-excel" },
      })
    )
    const output = path.join(directory, "report.xls")
    expect(await exportCards("xls", output)).toEqual({
      kind: "file",
      path: output,
      bytes: report.length,
    })
    expect(fs.readFileSync(output)).toEqual(report)
    expect(
      Object.fromEntries(
        new URLSearchParams(String(fetchMock.mock.calls[1][1]?.body))
      )
    ).toMatchObject({
      DateFrom: start,
      DateTo: end,
      AccountID: card,
      Report: "Excel",
    })
  })

  test.each([
    true,
    false,
  ])("saves XLS to downloads with or without a server filename (%s)", async (named) => {
    vi.spyOn(process, "cwd").mockReturnValue(directory)
    const headers: Record<string, string> = {
      "content-type": "application/vnd.ms-excel",
    }
    if (named) {
      headers["content-disposition"] =
        'attachment; filename="../../redacted.xls"'
    }
    fetchMock.mockResolvedValueOnce(html(page1))
    fetchMock.mockResolvedValueOnce(new Response(report, { headers }))
    const result = await exportCards("xls")
    expect(result?.kind).toBe("file")
    if (result?.kind === "file") {
      expect(path.dirname(result.path)).toBe(path.join(directory, "downloads"))
      expect(fs.readFileSync(result.path)).toEqual(report)
      expect(path.extname(result.path)).toBe(".xls")
    }
  })

  test("resolves a relative output path", async () => {
    fetchMock.mockResolvedValueOnce(html(page2))
    const relative = path.relative(
      process.cwd(),
      path.join(directory, "relative.json")
    )
    const result = await exportCards("json", relative)
    expect(result).toMatchObject({ kind: "file", path: path.resolve(relative) })
  })

  test.each([
    "",
    "directory",
    "missing/report.json",
  ])("rejects invalid output path %s before making requests", async (name) => {
    let output = path.join(directory, name)
    if (name === "") {
      output = ""
    } else if (name === "directory") {
      output = directory
    }
    await expect(exportCards("json", output)).rejects.toThrow("Output")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test.each([
    ["31.02.2024", end],
    ["29.02.2023", "01.03.2023"],
    ["1.01.2024", end],
    ["2024-01-01", end],
    ["01.13.2024", end],
    [start, "invalid"],
    [end, start],
  ])("rejects invalid or reversed dates %s–%s", async (from, to) => {
    await expect(
      cmdCardTransactions(cookie, card, from, to, "json")
    ).rejects.toThrow("date")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("accepts equal bounds and leap days", async () => {
    fetchMock.mockResolvedValueOnce(html(empty))
    expect(
      await cmdCardTransactions(
        cookie,
        card,
        "29.02.2024",
        "29.02.2024",
        "json"
      )
    ).toMatchObject({ kind: "data", jsonRows: [] })
    expect(String(fetchMock.mock.calls[0][1]?.body)).toContain(
      "DateFrom=29.02.2024&DateTo=29.02.2024"
    )
  })

  test.each([
    "pdf",
    "xml",
    "JSON",
  ])("rejects unsupported format %s", async (format) => {
    await expect(exportCards(format)).rejects.toThrow("Invalid format")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test.each([
    "tab",
    "csv",
    "json",
  ])("returns no data for an empty %s result", async (format) => {
    fetchMock.mockResolvedValueOnce(html(empty))
    expect(await exportCards(format)).toMatchObject({
      kind: "data",
      jsonRows: [],
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test.each(["csv", "json"])("writes a valid empty %s file", async (format) => {
    fetchMock.mockResolvedValueOnce(html(empty))
    const output = path.join(directory, `empty.${format}`)
    await exportCards(format, output)
    expect(fs.readFileSync(output, "utf-8")).toBe(
      format === "json" ? "[]\n" : "date,description,amount,currency\n"
    )
  })

  test.each([
    ["HTML", "<html>REDACTED error</html>", 200, "text/html"],
    ["empty body", "", 200, "application/vnd.ms-excel"],
    ["server error", "error", 500, "application/vnd.ms-excel"],
    ["wrong content type", "not a report", 200, "text/plain"],
  ])("rejects an invalid XLS response: %s", async (_name, body, status, contentType) => {
    fetchMock.mockResolvedValueOnce(html(page1))
    fetchMock.mockResolvedValueOnce(
      new Response(body, { status, headers: { "content-type": contentType } })
    )
    const output = path.join(directory, "report.xls")
    fs.writeFileSync(output, "previous export")
    await expect(exportCards("xls", output)).rejects.toThrow(
      status >= 400
        ? `HTTP ${status}`
        : "NLB did not return a valid XLS file. Try --format tab, csv, or json."
    )
    expect(fs.readFileSync(output, "utf-8")).toBe("previous export")
  })

  test.each([
    "json",
    "csv",
    "xls",
  ])("detects a session expiring during a %s export", async (format) => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "/Account/Login" },
      })
    )
    await expect(
      exportCards(format, path.join(directory, "output"))
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.authentication })
    expect(fs.existsSync(path.join(directory, "output"))).toBe(false)
  })

  test("does not treat a login page as an empty result", async () => {
    fetchMock.mockResolvedValueOnce(html(login))
    await expect(exportCards()).rejects.toMatchObject({
      exitCode: EXIT_CODES.authentication,
    })
  })

  test("keeps an existing export intact if the session expires on a later page", async () => {
    const output = path.join(directory, "report.json")
    fs.writeFileSync(output, "previous export")
    fetchMock
      .mockResolvedValueOnce(html(page1))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
    await expect(exportCards("json", output)).rejects.toMatchObject({
      exitCode: EXIT_CODES.authentication,
    })
    expect(fs.readFileSync(output, "utf-8")).toBe("previous export")
  })

  test("fails rather than returning partial results on an HTTP error", async () => {
    fetchMock
      .mockResolvedValueOnce(html(page1))
      .mockResolvedValueOnce(html("error", 500))
    await expect(exportCards()).rejects.toThrow("HTTP 500")
  })

  test("rejects a non-transaction HTML response", async () => {
    fetchMock.mockResolvedValueOnce(html("<html>REDACTED error</html>"))
    await expect(exportCards()).rejects.toThrow("valid transactions table")
  })

  test("follows more than two pages without dropping identical individual transactions", async () => {
    const middle = page1.replace("REDACTED REFUND", "REDACTED ANOTHER REFUND")
    fetchMock
      .mockResolvedValueOnce(html(page1))
      .mockResolvedValueOnce(html(middle))
      .mockResolvedValueOnce(html(page2))
    const result = await exportCards()
    expect(result?.kind === "data" && result.rows.length).toBe(5)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(
      new URLSearchParams(String(fetchMock.mock.calls[2][1]?.body)).get(
        "PageNumber"
      )
    ).toBe("2")
  })

  test("detects repeated pages instead of looping or duplicating results", async () => {
    fetchMock.mockImplementation(async () => html(page1))
    await expect(exportCards()).rejects.toThrow("repeated a transaction page")
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test("follows numeric pagination even if a server caps the page size", async () => {
    const numericPage = page1.replace(
      pagerPattern,
      '<ul class="pagination"><li><a href="?PageNumber=2">2</a></li></ul>'
    )
    fetchMock
      .mockResolvedValueOnce(html(numericPage))
      .mockResolvedValueOnce(html(page2))
    const result = await exportCards()
    expect(result?.kind === "data" && result.rows.length).toBe(3)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test("requests the next page for a full page without a pager and stops on an empty page", async () => {
    const fullPage = page2
      .replace(pagerPattern, "")
      .replace(
        tbodyPattern,
        `<tbody>${Array.from({ length: 20 }, (_, i) => `<tr><td>${end}</td><td>REDACTED ${i}</td><td>-1</td><td>MKD</td></tr>`).join("")}</tbody>`
      )
    fetchMock
      .mockResolvedValueOnce(html(fullPage))
      .mockResolvedValueOnce(html(empty))
    const result = await exportCards()
    expect(result?.kind === "data" && result.rows.length).toBe(20)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test("rejects ambiguous card headings rather than deriving unstable keys", async () => {
    const table = page2
      .replace("<th>date</th>", "<th>amount</th>")
      .replace("<th>currency</th>", "<th></th>")
    fetchMock.mockResolvedValueOnce(html(table))
    await expect(exportCards()).rejects.toThrow("valid transactions table")
  })

  test("rejects data without recognizable card headings", async () => {
    fetchMock.mockResolvedValueOnce(
      html(
        "<table><tbody><tr><td>REDACTED</td><td>-1.00</td></tr></tbody></table>"
      )
    )
    await expect(exportCards()).rejects.toThrow("valid transactions table")
  })

  test.each([
    "<table><tbody></tbody></table>",
    "<table><thead><tr><th>date</th></tr></thead><tbody></tbody></table>",
  ])("handles an empty table without a placeholder row", async (table) => {
    fetchMock.mockResolvedValueOnce(html(table))
    expect(await exportCards()).toMatchObject({ kind: "data", jsonRows: [] })
  })

  test("uses the server's page size when deciding whether to fetch more", async () => {
    const first = page1.replace(
      pagerPattern,
      '<input name="PageSize" value="2">'
    )
    fetchMock
      .mockResolvedValueOnce(html(first))
      .mockResolvedValueOnce(html(page2))
    const result = await exportCards()
    expect(result?.kind === "data" && result.rows.length).toBe(3)
  })
})

test("date defaults apply only to missing bounds", () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 0, 15, 12))
  expect(transactionDates()).toEqual({ start: "16.12.2025", end: "15.01.2026" })
  expect(transactionDates(start)).toEqual({ start, end: "15.01.2026" })
  expect(transactionDates(undefined, end)).toEqual({ start: "16.12.2025", end })
  expect(transactionDates(start, end)).toEqual({ start, end })
})
