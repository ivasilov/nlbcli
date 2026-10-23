import { afterEach, expect, test, vi } from "vitest"
import {
  cmdAccountBalance,
  cmdAccountReservations,
  cmdListAccounts,
} from "../src/commands/accounts"
import {
  cmdCardBalance,
  cmdCardTransactions,
  cmdListCards,
} from "../src/commands/cards"
import { mockResponse } from "./fixtures"

afterEach(() => vi.unstubAllGlobals())

test("redacted balance page lists unique account and card IDs", async () => {
  mockResponse("balances.html")
  expect(await cmdListAccounts("session=test")).toEqual([
    "000-0000000001-00MKD",
    "000-0000000002-00EUR",
  ])
  expect(await cmdListCards("session=test")).toEqual([
    "00000001/0000",
    "00000002/0000",
  ])
})

test("account balance fixture pins the positional selectors and missing values", async () => {
  mockResponse("account-balance.html")
  expect(await cmdAccountBalance("session=test", "redacted")).toEqual({
    "account-id": "redacted",
    "account-owner": "REDACTED OWNER",
    "account-status": "Active",
    "current-balance": "1.234,50",
    "available-balance": "1.200,00",
    "allowed-overdraft": "0,00",
    "reserved-funds": "34,50",
    "last-change": "29.02.2024",
    "last-interest": "",
  })
})

test("card balance fixture pins the positional selectors", async () => {
  mockResponse("card-balance.html")
  expect(await cmdCardBalance("session=test", "redacted")).toEqual({
    "card-id": "redacted",
    "current-balance": "1.234,50",
    "available-balance": "1.200,00",
    "reserved-funds": "34,50",
    "amount-to-pay": "0,00",
    "current-limit": "5.000,00",
    "card-type": "REDACTED TYPE",
    "card-number": "**** **** **** 0000",
    "credit-debit": "Debit",
  })
})

test("reservations fixture retains display values", async () => {
  mockResponse("reservations.html")
  expect(await cmdAccountReservations("session=test", "redacted")).toEqual([
    ["01.03.2024", "REDACTED SHOP", "34,50"],
  ])
})

test("card transactions use the normalized export parser and expected endpoint", async () => {
  const fetchMock = mockResponse("card-transactions.html")
  const result = await cmdCardTransactions(
    "session=test",
    "redacted",
    "01.01.2026",
    "31.01.2026",
    "json"
  )
  expect(result.jsonRows[0].amount).toBe("-12345.67")
  const [url, request] = fetchMock.mock.calls[0]
  expect(url.pathname).toBe("/Cms/Transactions")
  expect(new URLSearchParams(request.body).get("AccountID")).toBe("redacted")
})

test.each([
  "login.html",
  "error.html",
])("all bank page commands reject %s", async (name) => {
  mockResponse(name)
  const commands = [
    () => cmdListAccounts("test"),
    () => cmdListCards("test"),
    () => cmdAccountBalance("test", "redacted"),
    () => cmdCardBalance("test", "redacted"),
    () => cmdAccountReservations("test", "redacted"),
    () =>
      cmdCardTransactions(
        "test",
        "redacted",
        "01.01.2026",
        "31.01.2026",
        "json"
      ),
  ]
  for (const command of commands) {
    await expect(command()).rejects.toThrow()
  }
})
