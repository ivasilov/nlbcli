import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { cmdAccountTransactions } from "../src/commands/accounts"
import {
  headers,
  jsonRows,
  normalizedRows,
  readTransactionExport,
  rows,
  transactionHtml,
  transactionXls,
} from "./transaction-fixtures"

let directory: string

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "nlbcli-exports-"))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  fs.rmSync(directory, { recursive: true, force: true })
})

const formats = ["xls", "csv", "json"] as const
const xls = transactionXls()
const html = transactionHtml()

function exportTransactions(format: string, output?: string) {
  return cmdAccountTransactions(
    "session=test",
    "account-id",
    "01.08.2026",
    "31.08.2026",
    format,
    "",
    "",
    output
  )
}

function mockResponse(
  body: BodyInit | null,
  init?: ResponseInit,
  preflight = false
) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(body, init))
  if (preflight) {
    fetchMock.mockResolvedValueOnce(new Response(html))
  }
  vi.stubGlobal("fetch", fetchMock)
}

describe("cmdAccountTransactions", () => {
  test.each(
    formats
  )("writes valid %s to exactly the supplied destination", async (format) => {
    const output = path.join(
      directory,
      "chosen filename.without-format-extension"
    )
    mockResponse(
      format === "xls" ? xls : html,
      {
        headers: {
          "content-type":
            format === "xls" ? "application/vnd.ms-excel" : "text/html",
          "content-disposition":
            'attachment; filename="different-bank-filename.xls"',
        },
      },
      format === "xls"
    )

    const result = await exportTransactions(format, output)

    expect(result).toEqual({
      kind: "file",
      path: output,
      bytes: fs.statSync(output).size,
    })
    expect(fs.readdirSync(directory)).toEqual([path.basename(output)])
    expect(readTransactionExport(format, fs.readFileSync(output))).toEqual(
      format === "json"
        ? jsonRows
        : [headers, ...(format === "csv" ? normalizedRows : rows)]
    )
    const request = vi.mocked(fetch).mock.calls.at(-1)?.[1]
    expect(new URLSearchParams(String(request?.body)).get("Report")).toBe(
      format === "xls" ? "Excel" : ""
    )
  })

  test("validates a sibling temporary file before atomically replacing an existing destination", async () => {
    const output = path.join(directory, "export.xls")
    fs.writeFileSync(output, "previous export")
    mockResponse(xls, undefined, true)
    const rename = fs.renameSync
    const spy = vi
      .spyOn(fs, "renameSync")
      .mockImplementation((temporary, destination) => {
        expect(destination).toBe(output)
        expect(path.dirname(String(temporary))).toBe(directory)
        expect(temporary).not.toBe(destination)
        expect(fs.readFileSync(output, "utf-8")).toBe("previous export")
        expect(
          readTransactionExport("xls", fs.readFileSync(temporary))
        ).toEqual([headers, ...rows])
        rename(temporary, destination)
      })

    await exportTransactions("xls", output)

    expect(spy).toHaveBeenCalledOnce()
    expect(fs.readFileSync(output).equals(xls)).toBe(true)
    expect(fs.readdirSync(directory)).toEqual(["export.xls"])
  })

  describe.each(formats)("failed %s exports", (format) => {
    test.each([
      "HTML login",
      "HTML error with attachment headers",
      "HTTP error",
      "partial status",
      "partial range",
      "length mismatch",
      "truncated body",
      "empty body",
      "broken stream",
    ])("rejects %s and leaves no partial destination or temporary file", async (failure) => {
      const output = path.join(directory, `export.${format}`)
      for (const existing of [false, true]) {
        if (existing) {
          fs.writeFileSync(output, "previous export")
        }
        let body: BodyInit | null = format === "xls" ? xls : html
        const init: ResponseInit = { headers: {} }
        switch (failure) {
          case "HTML login":
            body =
              '<html><body><form action="/Account/Login"><input type="password"></form></body></html>'
            break
          case "HTML error with attachment headers":
            body = "<html><body>Server error</body></html>"
            init.headers = {
              "content-type": "application/vnd.ms-excel",
              "content-disposition": 'attachment; filename="report.xls"',
            }
            break
          case "HTTP error":
            init.status = 500
            break
          case "partial status":
            init.status = 206
            break
          case "partial range":
            init.headers = { "content-range": "bytes 0-99/200" }
            break
          case "length mismatch":
            init.headers = {
              "content-length": String(
                Buffer.byteLength(body as string | Buffer) + 100
              ),
            }
            break
          case "truncated body":
            body =
              format === "xls"
                ? xls.subarray(0, -1)
                : html.slice(0, html.indexOf("</tbody>"))
            break
          case "empty body":
            body = null
            break
          case "broken stream":
            body = new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array([1, 2, 3]))
              },
              pull(controller) {
                controller.error(new Error("Download interrupted"))
              },
            })
            break
          default:
            throw new Error(`Unexpected failure case: ${failure}`)
        }
        mockResponse(body, init, format === "xls")

        await expect(exportTransactions(format, output)).rejects.toThrow()

        expect(fs.existsSync(output)).toBe(existing)
        if (existing) {
          expect(fs.readFileSync(output, "utf-8")).toBe("previous export")
        }
        expect(fs.readdirSync(directory)).toEqual(
          existing ? [path.basename(output)] : []
        )
      }
    })
  })

  test.each([
    "csv",
    "json",
  ])("writes a valid empty %s export for a complete empty transaction table", async (format) => {
    const output = path.join(directory, `empty.${format}`)
    mockResponse(transactionHtml([]))

    await exportTransactions(format, output)

    const text = fs.readFileSync(output, "utf-8")
    expect(format === "json" ? JSON.parse(text) : text).toEqual(
      format === "json" ? [] : `${headers.join(",")}\n`
    )
  })

  test.each([
    "csv",
    "json",
  ])("rejects a truncated document even after a complete table (%s)", async (format) => {
    mockResponse(`<html><body>${html}`)
    await expect(
      exportTransactions(format, path.join(directory, "export"))
    ).rejects.toThrow("complete transaction table")
    expect(fs.readdirSync(directory)).toEqual([])
  })

  test.each([
    "</Workbook>",
    "</Worksheet>",
    "</Table>",
    "</Cell>",
  ])("rejects an incomplete SpreadsheetML report missing %s", async (closingTag) => {
    const report = fs.readFileSync(
      new URL("./fixtures/cards/report.xls", import.meta.url),
      "utf-8"
    )
    const output = path.join(directory, "export.xls")
    fs.writeFileSync(output, "previous export")
    mockResponse(
      report.replace(closingTag, ""),
      {
        headers: { "content-type": "application/vnd.ms-excel" },
      },
      true
    )

    await expect(exportTransactions("xls", output)).rejects.toThrow(
      "valid XLS file"
    )

    expect(fs.readFileSync(output, "utf-8")).toBe("previous export")
    expect(fs.readdirSync(directory)).toEqual(["export.xls"])
  })

  test("rejects a missing binary XLS EOF even when its cells can still be read", async () => {
    const damaged = Buffer.from(xls)
    const eof = damaged.lastIndexOf(Buffer.from([10, 0, 0, 0]))
    expect(eof).toBeGreaterThan(0)
    damaged.writeUInt16LE(1, eof)
    expect(readTransactionExport("xls", damaged)).toEqual([headers, ...rows])
    const output = path.join(directory, "export.xls")
    fs.writeFileSync(output, "previous export")
    mockResponse(
      damaged,
      {
        headers: { "content-type": "application/vnd.ms-excel" },
      },
      true
    )

    await expect(exportTransactions("xls", output)).rejects.toThrow(
      "valid XLS file"
    )

    expect(fs.readFileSync(output, "utf-8")).toBe("previous export")
    expect(fs.readdirSync(directory)).toEqual(["export.xls"])
  })

  test("rejects an XLS response truncated at a complete sector boundary", async () => {
    const output = path.join(directory, "export.xls")
    mockResponse(xls.subarray(0, -512), undefined, true)

    await expect(exportTransactions("xls", output)).rejects.toThrow(
      "valid XLS file"
    )

    expect(fs.readdirSync(directory)).toEqual([])
  })

  test("rejects SpreadsheetML without a worksheet", async () => {
    mockResponse(
      '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"></Workbook>',
      undefined,
      true
    )
    await expect(
      exportTransactions("xls", path.join(directory, "export.xls"))
    ).rejects.toThrow("valid XLS file")
    expect(fs.readdirSync(directory)).toEqual([])
  })

  test("cleans up when the atomic rename fails", async () => {
    const output = path.join(directory, "export.xls")
    fs.writeFileSync(output, "previous export")
    mockResponse(xls, undefined, true)
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("Rename failed")
    })

    await expect(exportTransactions("xls", output)).rejects.toThrow(
      "Rename failed"
    )

    expect(fs.readFileSync(output, "utf-8")).toBe("previous export")
    expect(fs.readdirSync(directory)).toEqual(["export.xls"])
  })

  test.each(
    formats
  )("does not commit an incomplete %s temporary file", async (format) => {
    const output = path.join(directory, "export")
    fs.writeFileSync(output, "previous export")
    mockResponse(format === "xls" ? xls : html, undefined, format === "xls")
    const write = fs.writeFileSync
    vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
      write(file, Buffer.isBuffer(data) ? data.subarray(0, -1) : data, options)
    })

    await expect(exportTransactions(format, output)).rejects.toThrow(
      "Incomplete export file"
    )

    expect(fs.readFileSync(output, "utf-8")).toBe("previous export")
    expect(fs.readdirSync(directory)).toEqual(["export"])
  })

  test.each([
    "csv",
    "json",
  ])("keeps returning %s data when no output path is supplied", async (format) => {
    mockResponse(html)
    await expect(exportTransactions(format)).resolves.toEqual({
      kind: "data",
      headers,
      rows: normalizedRows,
      tabRows: rows,
      jsonRows,
    })
  })
  test("rejects HTML returned for an XLS export", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(html))
        .mockResolvedValue(
          new Response("<html>Not a spreadsheet</html>", {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          })
        )
    )

    await expect(
      cmdAccountTransactions(
        "session=test",
        "account-id",
        "01.08.2026",
        "31.08.2026",
        "xls",
        "",
        ""
      )
    ).rejects.toThrow(
      "NLB did not return a valid XLS file. Try --format tab, csv, or json."
    )
  })

  test("rejects an empty PDF export", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 200,
          headers: { "content-type": "application/pdf" },
        })
      )
    )

    await expect(
      cmdAccountTransactions(
        "session=test",
        "account-id",
        "01.08.2026",
        "31.08.2026",
        "pdf",
        "",
        ""
      )
    ).rejects.toThrow(
      "NLB did not return a valid PDF file. Try --format tab, csv, or json."
    )
  })
})
