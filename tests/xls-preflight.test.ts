import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { cmdAccountTransactions } from "../src/commands/accounts"
import { cmdCardTransactions } from "../src/commands/cards"
import { EXIT_CODES } from "../src/errors"
import { fixture } from "./fixtures"

let directory: string

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "nlbcli-preflight-"))
  vi.spyOn(process, "cwd").mockReturnValue(directory)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  fs.rmSync(directory, { recursive: true, force: true })
})

function exportXls(kind: string, output?: string) {
  return kind === "account"
    ? cmdAccountTransactions(
        "session=test",
        "redacted",
        "01.09.2026",
        "30.09.2026",
        "xls",
        "out",
        "REDACTED",
        output
      )
    : cmdCardTransactions(
        "session=test",
        "redacted",
        "01.09.2026",
        "30.09.2026",
        "xls",
        output
      )
}

test.each([
  ["account", "no-data-transactions.html", false],
  ["account", "empty-transactions.html", true],
  ["card", "no-data-transactions.html", false],
  ["card", "cards/empty.html", true],
] as const)("skips an empty %s XLS export (%s, existing file: %s)", async (kind, page, existing) => {
  const output = path.join(directory, "transactions.xls")
  if (existing) {
    fs.writeFileSync(output, "previous export")
  }
  const fetchMock = vi.fn().mockImplementation((_url, init) => {
    if (new URLSearchParams(init.body).get("Report") === "Excel") {
      return Promise.resolve(new Response("failure", { status: 500 }))
    }
    return Promise.resolve(new Response(fixture(page)))
  })
  vi.stubGlobal("fetch", fetchMock)

  await expect(exportXls(kind, output)).resolves.toBeNull()
  expect(fetchMock).toHaveBeenCalledOnce()
  const [url, init] = fetchMock.mock.calls[0]
  expect(url.pathname).toBe(
    kind === "account" ? "/Retail/Transactions" : "/Cms/Transactions"
  )
  expect(Object.fromEntries(new URLSearchParams(init.body))).toMatchObject({
    AccountID: "redacted",
    DateFrom: "01.09.2026",
    DateTo: "30.09.2026",
    Report: "",
    PageNumber: "0",
  })
  if (kind === "account") {
    expect(Object.fromEntries(new URLSearchParams(init.body))).toMatchObject({
      Direction: "-1",
      OtherPartyName: "REDACTED",
    })
  }
  expect(fs.readdirSync(directory)).toEqual(
    existing ? ["transactions.xls"] : []
  )
  if (existing) {
    expect(fs.readFileSync(output, "utf-8")).toBe("previous export")
  }
})

test.each([
  "account",
  "card",
])("does not create downloads for an empty %s XLS export", async (kind) => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response(fixture("no-data-transactions.html")))
  vi.stubGlobal("fetch", fetchMock)

  await expect(exportXls(kind)).resolves.toBeNull()
  expect(fetchMock).toHaveBeenCalledOnce()
  expect(fs.readdirSync(directory)).toEqual([])
})

test.each([
  "account",
  "card",
])("exports %s XLS after checking only the first page and carrying session cookies forward", async (kind) => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        fixture(`${kind === "account" ? "accounts" : "cards"}/page-1.html`),
        {
          headers: { "set-cookie": "session=preflight; Path=/" },
        }
      )
    )
    .mockResolvedValueOnce(new Response(fixture("report.xls")))
  vi.stubGlobal("fetch", fetchMock)
  const output = path.join(directory, "transactions.xls")

  await expect(exportXls(kind, output)).resolves.toMatchObject({
    kind: "file",
    path: output,
  })
  expect(fetchMock).toHaveBeenCalledTimes(2)
  const [preflight, report] = fetchMock.mock.calls
  const fields = Object.fromEntries(new URLSearchParams(preflight[1].body))
  expect(fields.Report).toBe("")
  expect(Object.fromEntries(new URLSearchParams(report[1].body))).toEqual({
    ...fields,
    Report: "Excel",
  })
  expect(report[0].pathname).toBe(preflight[0].pathname)
  expect(report[1].headers.Cookie).toBe("session=preflight")
  expect(fs.readFileSync(output)).toEqual(fixture("report.xls"))
})

test.each([
  ["login.html", 200, EXIT_CODES.authentication],
  ["error.html", 200, EXIT_CODES.bankResponse],
  ["malformed-transactions.html", 200, EXIT_CODES.bankResponse],
  ["no-data-transactions.html", 500, EXIT_CODES.bankResponse],
  ["no-data-transactions.html", 206, EXIT_CODES.bankResponse],
] as const)("does not treat a failed preflight as empty (%s, HTTP %s)", async (page, status, exitCode) => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response(fixture(page), { status }))
  vi.stubGlobal("fetch", fetchMock)

  await expect(exportXls("account")).rejects.toMatchObject({ exitCode })
  expect(fetchMock).toHaveBeenCalledOnce()
  expect(fs.readdirSync(directory)).toEqual([])
})

test("rejects an empty preflight for a different account", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(
      new Response(
        `<h4 class="widget-title"><strong>other-account</strong></h4>${fixture("no-data-transactions.html")}`
      )
    )
  vi.stubGlobal("fetch", fetchMock)

  await expect(exportXls("account")).rejects.toThrow("different account")
  expect(fetchMock).toHaveBeenCalledOnce()
  expect(fs.readdirSync(directory)).toEqual([])
})
