import { afterEach, expect, test, vi } from "vitest"
import { printCsv, printJson } from "../src/formatters"
import { parseTransactions } from "../src/transactions"
import { page } from "./fixtures"

afterEach(() => vi.restoreAllMocks())

test.each([
  ["account", "date,recipient,description,status,amount,fee,balance"],
  ["card", "date,description,amount,currency"],
] as const)("%s CSV pins the header and normalized row order", (kind, header) => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
  const result = parseTransactions(page(`${kind}-transactions.html`), kind)
  printCsv(result.rows, result.headers)
  const lines = String(log.mock.calls[0][0]).split("\n")
  expect(lines[0]).toBe(header)
  expect(lines[1]).toBe(
    kind === "account"
      ? '2024-02-29,REDACTED & CO,"Invoice, ""test""",Booked,-1234.50,0.00,9007199254740993.01'
      : "2025-12-31,REDACTED SHOP,-12345.67,MKD"
  )
})

test("CSV quotes commas, quotes, LF and CR", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
  printCsv(
    [["a,b", 'a"b', "a\nb", "a\rb", ""]],
    ["comma", "quote", "lf", "cr", "null"]
  )
  expect(log.mock.calls[0]).toEqual([
    'comma,quote,lf,cr,null\n"a,b","a""b","a\nb","a\rb",',
  ])
})

test("empty JSON and CSV remain machine-readable", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
  const result = parseTransactions(page("empty-transactions.html"), "account")
  printJson(result.jsonRows)
  printCsv(result.rows, result.headers)
  expect(log.mock.calls).toEqual([
    ["[]"],
    ["date,recipient,description,status,amount,fee,balance"],
  ])
})
