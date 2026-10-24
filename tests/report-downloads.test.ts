import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { cmdAccountTransactions } from "../src/commands/accounts"
import { cmdCardTransactions } from "../src/commands/cards"
import { EXIT_CODES } from "../src/errors"
import { fixture } from "./fixtures"
import headers from "./fixtures/report-headers.json"

let directory: string

const reportPath = "/Retail/RenderReport/RetTransactions01092026000000"
const wrapper = fixture("accounts/report-wrapper.html").toString("utf-8")

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "nlbcli-report-download-"))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  fs.rmSync(directory, { recursive: true, force: true })
})

function exportAccount(format = "xls", output?: string) {
  return cmdAccountTransactions(
    "session=test",
    "redacted",
    "01.09.2026",
    "30.09.2026",
    format,
    "out",
    "REDACTED",
    output
  )
}

test.each([
  ["account", "xls"],
  ["account", "pdf"],
  ["card", "xls"],
] as const)("downloads the %s %s report referenced by an HTML wrapper", async (kind, format) => {
  const downloadPath =
    kind === "account" ? reportPath : reportPath.replace("/Retail/", "/Cms/")
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(wrapper.replace(reportPath, downloadPath), {
        headers: { "set-cookie": "session=updated; Path=/" },
      })
    )
    .mockResolvedValueOnce(
      new Response(fixture(`report.${format}`), { headers: headers[format] })
    )
  vi.stubGlobal("fetch", fetchMock)
  vi.spyOn(process, "cwd").mockReturnValue(directory)
  const output = path.join(directory, "chosen destination")

  const result =
    kind === "account"
      ? await exportAccount(format, output)
      : await cmdCardTransactions(
          "session=test",
          "redacted",
          "01.09.2026",
          "30.09.2026",
          format,
          output
        )

  expect(result).toEqual({
    kind: "file",
    path: output,
    bytes: fixture(`report.${format}`).length,
  })
  expect(fs.readFileSync(output)).toEqual(fixture(`report.${format}`))
  expect(fetchMock).toHaveBeenCalledTimes(2)
  const params = new URLSearchParams(fetchMock.mock.calls[0][1].body)
  expect(Object.fromEntries(params)).toMatchObject({
    AccountID: "redacted",
    DateFrom: "01.09.2026",
    DateTo: "30.09.2026",
    Report: format === "xls" ? "Excel" : "Pdf",
  })
  expect(fetchMock.mock.calls[1][0].href).toBe(
    `https://www.nlbklik.com.mk${downloadPath}`
  )
  expect(fetchMock.mock.calls[1][1]).toMatchObject({
    method: "GET",
    redirect: "manual",
    headers: { Cookie: "session=updated" },
  })
  expect(fs.readdirSync(directory)).toEqual(["chosen destination"])
})

test("uses the downloaded report's filename when --output is omitted", async () => {
  vi.spyOn(process, "cwd").mockReturnValue(directory)
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(new Response(wrapper))
      .mockResolvedValueOnce(
        new Response(fixture("report.xls"), { headers: headers.xls })
      )
  )

  expect(await exportAccount()).toMatchObject({
    kind: "file",
    path: path.join(directory, "downloads", "redacted.xls"),
  })
  expect(
    fs.readFileSync(path.join(directory, "downloads", "redacted.xls"))
  ).toEqual(fixture("report.xls"))
})

test.each([
  "https://other.example/Retail/RenderReport/report",
  "//other.example/Retail/RenderReport/report",
  "https://user:secret@www.nlbklik.com.mk/Retail/RenderReport/report",
  "/Cms/RenderReport/report",
  "/Retail/Account",
  "/Retail/RenderReport/../Account",
  "/Retail/RenderReport/%2fAccount",
  "/Retail/RenderReport/report?redirect=elsewhere",
  "javascript:alert(1)",
])("rejects an unexpected report location without fetching it: %s", async (location) => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response(wrapper.replace(reportPath, location)))
  vi.stubGlobal("fetch", fetchMock)

  await expect(
    exportAccount("xls", path.join(directory, "report.xls"))
  ).rejects.toMatchObject({ exitCode: EXIT_CODES.bankResponse })

  expect(fetchMock).toHaveBeenCalledOnce()
  expect(fs.readdirSync(directory)).toEqual([])
})

test.each([
  `${wrapper}${wrapper}`,
  `<div class="error-page">REDACTED error</div>${wrapper}`,
  `<h4 class="widget-title"><strong>other-account</strong></h4>${wrapper}`,
])("rejects ambiguous, failed, or mismatched HTML report wrappers", async (body) => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(body))
  vi.stubGlobal("fetch", fetchMock)

  await expect(
    exportAccount("xls", path.join(directory, "report.xls"))
  ).rejects.toMatchObject({ exitCode: EXIT_CODES.bankResponse })

  expect(fetchMock).toHaveBeenCalledOnce()
  expect(fs.readdirSync(directory)).toEqual([])
})

test.each([
  ["HTTP error", "failure", { status: 500 }],
  ["login redirect", "", { status: 302 }],
  ["invalid workbook", "<html>Not a workbook</html>", {}],
  ["partial report", fixture("report.xls"), { status: 206 }],
  [
    "truncated report",
    fixture("report.xls"),
    { headers: { "content-length": "999999" } },
  ],
] as const)("keeps an existing destination when the download fails: %s", async (_name, body, init) => {
  const output = path.join(directory, "report.xls")
  fs.writeFileSync(output, "previous export")
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response(wrapper))
    .mockResolvedValueOnce(new Response(body, init))
  vi.stubGlobal("fetch", fetchMock)

  await expect(exportAccount("xls", output)).rejects.toThrow()

  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(fs.readFileSync(output, "utf-8")).toBe("previous export")
  expect(fs.readdirSync(directory)).toEqual(["report.xls"])
})
