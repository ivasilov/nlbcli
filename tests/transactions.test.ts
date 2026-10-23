import Ajv from "ajv"
import addFormats from "ajv-formats"
import { describe, expect, test } from "vitest"
import accountSchema from "../schemas/account-transactions-v1.schema.json"
import cardSchema from "../schemas/card-transactions-v1.schema.json"
import {
  ACCOUNT_TRANSACTION_FIELDS,
  CARD_TRANSACTION_FIELDS,
  normalizeAmount,
  normalizeDate,
  parseTransactions,
} from "../src/transactions"
import { page } from "./fixtures"

const ajv = new Ajv({ strict: true })
addFormats(ajv)
const tableHead = /<thead>.*?<\/thead>/s

describe("transaction values", () => {
  test.each([
    ["29.02.2024", "2024-02-29"],
    [" 1.3.2026. ", "2026-03-01"],
    ["31.12.2025", "2025-12-31"],
    ["01.01.2026", "2026-01-01"],
    ["2026-10-23", "2026-10-23"],
    ["", null],
    ["-", null],
  ])("normalizes date %s", (value, expected) => {
    expect(normalizeDate(value)).toBe(expected)
  })

  test.each([
    "29.02.2025",
    "29.02.1900",
    "31.04.2026",
    "00.01.2026",
    "01.13.2026",
    "01.01.0000",
    "2026-02-30",
    "10/23/2026",
    "23.10.26",
    "not a date",
  ])("rejects invalid date %s", (value) => {
    expect(() => normalizeDate(value)).toThrow("Invalid transaction date")
  })

  test.each([
    ["1.234,56", "1234.56"],
    ["1,234.56", "1234.56"],
    ["9,007,199,254,740,993.1234", "9007199254740993.1234"],
    ["-123.45", "-123.45"],
    ["0.00", "0.00"],
    ["1.234", "1234"],
    ["-1.234,50", "-1234.50"],
    ["−1.234,50", "-1234.50"],
    ["+00042,5000", "42.5000"],
    ["\u00a09.007.199.254.740.993,1234\u00a0", "9007199254740993.1234"],
    ["0", "0"],
    ["-0,00", "0.00"],
    [
      "123456789012345678901234567890,000001",
      "123456789012345678901234567890.000001",
    ],
    ["", null],
    ["-", null],
  ])("normalizes amount %s exactly", (value, expected) => {
    expect(normalizeAmount(value)).toBe(expected)
  })

  test.each([
    "1,23.56",
    "12.3.4",
    "1.23.456,78",
    "1,2,3",
    "1e5",
    "NaN",
    "Infinity",
    "123 MKD",
    "--2",
    "(12,00)",
  ])("rejects invalid amount %s", (value) => {
    expect(() => normalizeAmount(value)).toThrow("Invalid transaction amount")
  })
})

describe("transaction pages", () => {
  test.each([
    "MKD",
    "EUR",
    "USD",
  ])("parses %s amounts from the live account layout", (currency) => {
    const response = page("accounts/live-transactions.html")
    response.body = Buffer.from(
      response.body.toString().replaceAll("MKD", currency)
    )
    const result = parseTransactions(response, "account")
    expect(result.jsonRows).toEqual([
      {
        date: "2024-01-31",
        recipient: "REDACTED RECIPIENT",
        description: "REDACTED PAYMENT",
        status: "Completed",
        amount: "-1234.50",
        fee: "0.00",
        balance: "9007199254740993.01",
      },
    ])
    expect(result.tabRows[0].slice(4)).toEqual([
      `-1.234,50 ${currency}`,
      `0,00 ${currency}`,
      `9.007.199.254.740.993,01 ${currency}`,
    ])
  })

  test("account fixture pins keys, dates, nulls, signs and precision", () => {
    const result = parseTransactions(
      page("account-transactions.html"),
      "account"
    )
    expect(result.headers).toEqual(ACCOUNT_TRANSACTION_FIELDS)
    expect(result.jsonRows).toEqual([
      {
        date: "2024-02-29",
        recipient: "REDACTED & CO",
        description: 'Invoice, "test"',
        status: "Booked",
        amount: "-1234.50",
        fee: "0.00",
        balance: "9007199254740993.01",
      },
      {
        date: "2024-03-01",
        recipient: null,
        description: "Refund",
        status: null,
        amount: "42.5000",
        fee: null,
        balance: null,
      },
    ])
    expect(Object.keys(result.jsonRows[0])).toEqual(ACCOUNT_TRANSACTION_FIELDS)
    expect(result.rows[1]).toEqual([
      "2024-03-01",
      "",
      "Refund",
      "",
      "42.5000",
      "",
      "",
    ])
    expect(result.tabRows[0][0]).toBe("29.02.2024")
    expect(ajv.compile(accountSchema)(result.jsonRows)).toBe(true)
  })

  test("card fixture maps reordered bank columns to stable keys", () => {
    const result = parseTransactions(page("card-transactions.html"), "card")
    expect(result.headers).toEqual(CARD_TRANSACTION_FIELDS)
    expect(result.jsonRows).toEqual([
      {
        date: "2025-12-31",
        description: "REDACTED SHOP",
        amount: "-12345.67",
        currency: "MKD",
      },
      {
        date: "2026-01-01",
        description: null,
        amount: "9007199254740993.1234",
        currency: null,
      },
    ])
    expect(Object.keys(result.jsonRows[0])).toEqual(CARD_TRANSACTION_FIELDS)
    expect(result.rows[0]).toEqual([
      "2025-12-31",
      "REDACTED SHOP",
      "-12345.67",
      "MKD",
    ])
    expect(ajv.compile(cardSchema)(result.jsonRows)).toBe(true)
  })

  test.each([
    "account",
    "card",
  ] as const)("empty %s table keeps fixed headers", (kind) => {
    const result = parseTransactions(page("empty-transactions.html"), kind)
    expect(result.jsonRows).toEqual([])
    expect(result.headers).toEqual(
      kind === "account" ? ACCOUNT_TRANSACTION_FIELDS : CARD_TRANSACTION_FIELDS
    )
  })

  test("missing optional columns produce nulls and blank cells", () => {
    const response = page("empty-transactions.html")
    response.body = Buffer.from(
      "<table><thead><tr><th>Date</th><th>Amount</th></tr></thead><tbody><tr><td></td><td>0,00</td></tr></tbody></table>"
    )
    const result = parseTransactions(response, "card")
    expect(result.jsonRows).toEqual([
      { date: null, description: null, amount: "0.00", currency: null },
    ])
    expect(result.rows).toEqual([["", "", "0.00", ""]])
  })

  test.each([
    "account",
    "card",
  ] as const)("recognizes the bank's no-data notice as empty %s transactions", (kind) => {
    const result = parseTransactions(page("no-data-transactions.html"), kind)
    expect(result.jsonRows).toEqual([])
    expect(result.rows).toEqual([])
    expect(result.tabRows).toEqual([])
    expect(result.headers).toEqual(
      kind === "account" ? ACCOUNT_TRANSACTION_FIELDS : CARD_TRANSACTION_FIELDS
    )
  })

  test("a no-data notice cannot hide an unrecognized transaction table", () => {
    const response = page("no-data-transactions.html")
    response.body = Buffer.concat([
      response.body,
      Buffer.from("<table><tbody><tr><td>Unexpected</td></tr></tbody></table>"),
    ])
    expect(() => parseTransactions(response, "account")).toThrow(
      "Unrecognized NLB transaction table"
    )
  })

  test("supports the existing headerless account fragment", () => {
    const response = page("account-transactions.html")
    response.body = Buffer.from(response.body.toString().replace(tableHead, ""))
    expect(parseTransactions(response, "account").jsonRows[0].amount).toBe(
      "-1234.50"
    )
  })

  test("preserves legacy account positions when headings are not recognized", () => {
    const response = page("account-transactions.html")
    response.body = Buffer.from(
      response.body
        .toString()
        .replace(
          tableHead,
          "<thead><tr><th>Details</th><th>Other date label</th><th>Other recipient label</th><th>Other description label</th><th>Other status label</th><th>Other amount label</th><th>Other fee label</th><th>Other balance label</th></tr></thead>"
        )
    )
    expect(parseTransactions(response, "account").jsonRows[0].balance).toBe(
      "9007199254740993.01"
    )
  })

  test("ignores unrelated layout tables when transaction headings are recognized", () => {
    const response = page("account-transactions.html")
    response.body = Buffer.concat([
      response.body,
      Buffer.from("<table><tbody><tr><td>Layout</td></tr></tbody></table>"),
    ])
    expect(parseTransactions(response, "account").jsonRows).toHaveLength(2)
  })

  test.each([
    "account",
    "card",
  ] as const)("rejects truncated %s rows", (kind) => {
    expect(() =>
      parseTransactions(page("malformed-transactions.html"), kind)
    ).toThrow("Malformed NLB transaction row")
  })

  test.each([
    ["29.02.2024", "31.02.2024", "date"],
    ["−1.234,50", "NaN", "amount"],
    ["0,00", "1e6", "amount"],
    ["9.007.199.254.740.993,01", "123 USDD", "amount"],
  ])("fails the entire response for malformed %s", (before, after, field) => {
    const response = page("account-transactions.html")
    response.body = Buffer.from(response.body.toString().replace(before, after))
    expect(() => parseTransactions(response, "account")).toThrow(
      `Invalid transaction ${field}`
    )
  })

  test.each(["login.html", "error.html"])("rejects HTTP 200 %s", (name) => {
    expect(() => parseTransactions(page(name), "account")).toThrow()
    expect(() => parseTransactions(page(name), "card")).toThrow()
  })

  test.each([
    "",
    "{broken json",
    "<html><body>Unexpected response</body></html>",
    "<table><tbody>",
    "<table><thead><tr><th>Date</th><th>Amount</th></tr></thead></table>",
  ])("rejects unrecognized responses %s", (body) => {
    expect(() =>
      parseTransactions(
        { ...page("account-transactions.html"), body: Buffer.from(body) },
        "account"
      )
    ).toThrow()
  })

  test.each([
    302, 401, 403, 500,
  ])("rejects HTTP %s even with a valid table", (status) => {
    expect(() =>
      parseTransactions(
        { ...page("account-transactions.html"), status },
        "account"
      )
    ).toThrow()
  })

  test.each([
    accountSchema,
    cardSchema,
  ])("schema rejects numeric money, extra keys and absent keys", (schema) => {
    const validate = ajv.compile(schema)
    const data = parseTransactions(
      page(
        schema === accountSchema
          ? "account-transactions.html"
          : "card-transactions.html"
      ),
      schema === accountSchema ? "account" : "card"
    ).jsonRows
    expect(validate([{ ...data[0], amount: 123.45 }])).toBe(false)
    expect(validate([{ ...data[0], unexpected: "value" }])).toBe(false)
    expect(validate([{ amount: "123.45" }])).toBe(false)
  })
})
