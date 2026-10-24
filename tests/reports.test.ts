import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, expect, test, vi } from "vitest"
import { cmdAccountTransactions } from "../src/commands/accounts"
import {
  validateExportResponse,
  validatePdf,
  validateXls,
} from "../src/exports"
import { fixture, mockResponse, page } from "./fixtures"
import headers from "./fixtures/report-headers.json"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

test.each([
  "xls",
  "pdf",
] as const)("saves valid %s response byte-for-byte", async (format) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nlbcli-report-"))
  vi.spyOn(process, "cwd").mockReturnValue(dir)
  const fetchMock = mockResponse(`report.${format}`, 200, headers[format])
  if (format === "xls") {
    fetchMock.mockResolvedValueOnce(
      new Response(fixture("accounts/page-1.html"))
    )
  }
  try {
    const result = await cmdAccountTransactions(
      "session=test",
      "redacted",
      "01.01.2026",
      "31.01.2026",
      format,
      "out",
      "REDACTED"
    )
    expect(result).toEqual({
      kind: "file",
      path: path.join(dir, "downloads", `redacted.${format}`),
      bytes: fixture(`report.${format}`).length,
    })
    expect(
      fs.readFileSync(path.join(dir, "downloads", `redacted.${format}`))
    ).toEqual(fixture(`report.${format}`))
    const [url, request] = fetchMock.mock.calls[format === "xls" ? 1 : 0]
    expect(url.pathname).toBe("/Retail/Transactions")
    const params = new URLSearchParams(request.body)
    expect(params.get("Report")).toBe(format === "xls" ? "Excel" : "Pdf")
    expect(params.get("Direction")).toBe("-1")
    expect(params.get("OtherPartyName")).toBe("REDACTED")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test.each([
  "xls",
  "pdf",
] as const)("rejects HTML login/error responses even with forged %s headers", (format) => {
  for (const name of [
    "login.html",
    "error.html",
    "malformed-transactions.html",
  ]) {
    const response = { ...page(name), headers: headers[format] }
    expect(() =>
      (format === "xls" ? validateXls : validatePdf)(response.body)
    ).toThrow(`valid ${format.toUpperCase()} file`)
  }
})

test.each([
  "xls",
  "pdf",
] as const)("rejects empty, malformed, redirected, and failed %s responses", (format) => {
  const valid = {
    status: 200,
    setCookies: [],
    headers: headers[format],
    body: fixture(`report.${format}`),
  }
  for (const response of [
    { ...valid, body: Buffer.alloc(0) },
    { ...valid, body: Buffer.from("malformed report") },
    { ...valid, body: Buffer.from("%PDF-1.4\n") },
    { ...valid, body: Buffer.from("d0cf11e0a1b11ae1", "hex") },
    { ...valid, status: 302 },
    { ...valid, status: 500 },
  ]) {
    expect(() => {
      validateExportResponse(response)
      const validate = format === "xls" ? validateXls : validatePdf
      validate(response.body)
    }).toThrow()
  }
})

test.each([
  "../../redacted.pdf",
  "C:\\private\\redacted.pdf",
])("report filenames cannot escape downloads: %s", async (filename) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nlbcli-filename-"))
  vi.spyOn(process, "cwd").mockReturnValue(dir)
  mockResponse("report.pdf", 200, {
    ...headers.pdf,
    "content-disposition": `attachment; filename="${filename}"`,
  })
  try {
    const result = await cmdAccountTransactions(
      "test",
      "redacted",
      "01.01.2026",
      "31.01.2026",
      "pdf",
      "",
      ""
    )
    expect(result).toMatchObject({
      kind: "file",
      path: path.join(dir, "downloads", "redacted.pdf"),
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("rejecting a report leaves no partial download or temporary file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nlbcli-reject-"))
  vi.spyOn(process, "cwd").mockReturnValue(dir)
  mockResponse("login.html", 200, headers.xls)
  try {
    await expect(
      cmdAccountTransactions(
        "test",
        "redacted",
        "01.01.2026",
        "31.01.2026",
        "xls",
        "",
        ""
      )
    ).rejects.toThrow()
    expect(
      fs.existsSync(path.join(dir, "downloads"))
        ? fs.readdirSync(path.join(dir, "downloads"))
        : []
    ).toEqual([])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
