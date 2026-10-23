import readline from "node:readline"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { runCli } from "../src/cli"
import { EXIT_CODES } from "../src/errors"
import { loadState } from "../src/state"

vi.mock("../src/state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/state")>()),
  loadState: vi.fn(),
  saveCookies: vi.fn(),
}))

const account = "210-1234567890-12MKD"
const card = "123456789012/1234"
const balances = `<html><div>${account} ${card}</div></html>`
const rows =
  "<table><tbody><tr><td>select</td><td>01.10.2026</td><td>Recipient</td><td>Payment</td><td>Completed</td><td>100</td><td>0</td><td>900</td></tr></tbody></table>"
const commands = [
  ["accounts", "list"],
  ["accounts", "balance", account, "--format", "json"],
  ["accounts", "transactions", account, "--format", "json"],
  ["accounts", "reservations", account],
  ["cards", "list"],
  ["cards", "balance", card],
  ["cards", "transactions", card],
]

function bankPage(url: string | URL): Response {
  const pathname = new URL(url).pathname
  if (pathname === "/Home/Balances") {
    return new Response(balances)
  }
  if (pathname === "/Retail/Account") {
    return new Response(
      Array.from(
        { length: 16 },
        (_, i) => `<div class="dps-content">${i}</div>`
      ).join("")
    )
  }
  if (pathname === "/Cms/Account") {
    const cells = Array.from({ length: 19 }, (_, i) => `<div>${i}</div>`).join(
      ""
    )
    return new Response(
      `<form id="main_CmsAccountBalanceForm"><div class="col-lg-12"><div class="col-lg-8"><div class="row">${cells}</div></div></div></form>`
    )
  }
  if (pathname === "/Cms/Transactions") {
    return new Response(
      "<table><thead><tr><th>Date</th><th>Description</th><th>Amount</th><th>Currency</th></tr></thead><tbody><tr><td>01.10.2026</td><td>Payment</td><td>100</td><td>MKD</td></tr></tbody></table>"
    )
  }
  return new Response(rows)
}

const fetchMock = vi.fn<typeof fetch>()
let stdout: ReturnType<typeof vi.spyOn>
let stderr: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(loadState).mockReturnValue({
    cookie: "session=test",
    username: "alice",
  })
  fetchMock
    .mockReset()
    .mockImplementation((url) => Promise.resolve(bankPage(String(url))))
  vi.stubGlobal("fetch", fetchMock)
  stdout = vi.spyOn(console, "log").mockImplementation(() => undefined)
  stderr = vi.spyOn(console, "error").mockImplementation(() => undefined)
  vi.spyOn(readline, "createInterface").mockImplementation(() => {
    throw new Error("Non-interactive commands must never prompt")
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe.each(["default", "work"])("%s profile", (profile) => {
  describe.each(commands)("non-interactive %s %s", (...command) => {
    test("missing session fails without contacting the bank", async () => {
      vi.mocked(loadState).mockReturnValue(null)
      expect(
        await runCli([
          "node",
          "nlbcli",
          "--profile",
          profile,
          "--non-interactive",
          ...command,
        ])
      ).toBe(EXIT_CODES.authentication)
      expect(vi.mocked(loadState).mock.calls).toEqual([[profile]])
      expect(fetchMock).not.toHaveBeenCalled()
      expect(stdout).not.toHaveBeenCalled()
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining(
          `nlbcli --profile ${profile} login --username <user>`
        )
      )
    })

    test("valid session returns data with progress only on stderr", async () => {
      expect(
        await runCli([
          "node",
          "nlbcli",
          "--profile",
          profile,
          ...command,
          "--non-interactive",
        ])
      ).toBe(EXIT_CODES.success)
      expect(stdout).toHaveBeenCalled()
      expect(stderr).toHaveBeenCalledWith("Using saved session.")
      expect(stdout).not.toHaveBeenCalledWith("Using saved session.")
      expect(loadState).toHaveBeenCalledWith(profile)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      for (const [, init] of fetchMock.mock.calls) {
        expect(init?.headers).toMatchObject({ Cookie: "session=test" })
        expect(init?.redirect).toBe("manual")
      }
    })

    test("expired session fails without push approval", async () => {
      fetchMock.mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: { location: "/Account/Login" },
        })
      )
      expect(
        await runCli([
          "node",
          "nlbcli",
          "--profile",
          profile,
          "--non-interactive",
          ...command,
        ])
      ).toBe(EXIT_CODES.authentication)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(stdout).not.toHaveBeenCalled()
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining(
          `nlbcli --profile ${profile} login --username 'alice'`
        )
      )
    })
  })
})

test.each([
  401, 403, 303, 307, 308,
])("HTTP %s login response is an authentication error", async (status) => {
  fetchMock.mockResolvedValue(
    new Response(null, { status, headers: { location: "/Account/Login" } })
  )
  expect(
    await runCli(["node", "nlbcli", "--non-interactive", "cards", "list"])
  ).toBe(EXIT_CODES.authentication)
  expect(stdout).not.toHaveBeenCalled()
})

test("expired redirects fail without reading or waiting for the response body", async () => {
  const response = new Response(null, { status: 302 })
  const readBody = vi
    .spyOn(response, "arrayBuffer")
    .mockRejectedValue(new Error("Body must not be read"))
  fetchMock.mockResolvedValue(response)
  expect(
    await runCli([
      "node",
      "nlbcli",
      "--profile",
      "work",
      "--non-interactive",
      "cards",
      "list",
    ])
  ).toBe(EXIT_CODES.authentication)
  expect(readBody).not.toHaveBeenCalled()
  expect(stdout).not.toHaveBeenCalled()
})

test("expiry between validation and data request includes the saved user's login command", async () => {
  fetchMock
    .mockResolvedValueOnce(new Response(balances))
    .mockResolvedValueOnce(
      new Response(
        '<form action="/Account/Login"><input name="UserName"></form>'
      )
    )
  expect(
    await runCli([
      "node",
      "nlbcli",
      "--non-interactive",
      "accounts",
      "transactions",
      account,
      "--format",
      "json",
    ])
  ).toBe(EXIT_CODES.authentication)
  expect(stdout).not.toHaveBeenCalled()
  expect(stderr).toHaveBeenCalledWith(
    expect.stringContaining("nlbcli --profile default login --username 'alice'")
  )
})

test.each([
  ["accounts", "balance"],
  ["accounts", "balance", account, "--format", "bogus"],
  ["accounts", "transactions", account, "--type", "bogus"],
  ["accounts", "transactions", account, "--start", "2026-10-01"],
  ["accounts", "transactions", account, "--end", "31.02.2026"],
  ["cards", "list", "--bogus"],
  ["login"],
  ["accounts", "list", "--wizard"],
  ["accounts", "list", "--WIZARD"],
])("invalid arguments fail before authentication: %s %s", async (...command) => {
  expect(
    await runCli(["node", "nlbcli", "--non-interactive", ...command])
  ).toBe(EXIT_CODES.arguments)
  expect(fetchMock).not.toHaveBeenCalled()
  expect(stdout).not.toHaveBeenCalled()
  expect(stderr).toHaveBeenCalled()
})

test("network errors have a distinct exit code and no stdout", async () => {
  fetchMock.mockRejectedValue(new TypeError("fetch failed"))
  expect(
    await runCli(["node", "nlbcli", "--non-interactive", "accounts", "list"])
  ).toBe(EXIT_CODES.network)
  expect(stdout).not.toHaveBeenCalled()
  expect(stderr).toHaveBeenCalledWith(
    expect.stringContaining("Unable to reach NLB")
  )
})

test("requests use a finite timeout and classify timeouts as network errors", async () => {
  const timeout = vi
    .spyOn(AbortSignal, "timeout")
    .mockReturnValue(AbortSignal.abort())
  fetchMock.mockImplementation((_url, init) => {
    init?.signal?.throwIfAborted()
    throw new Error("Expected an aborted request")
  })
  expect(
    await runCli(["node", "nlbcli", "--non-interactive", "cards", "list"])
  ).toBe(EXIT_CODES.network)
  expect(timeout).toHaveBeenCalledWith(15_000)
  expect(stdout).not.toHaveBeenCalled()
})

test("interrupted response bodies are network errors", async () => {
  const response = new Response(balances)
  vi.spyOn(response, "arrayBuffer").mockRejectedValue(
    new Error("Connection lost")
  )
  fetchMock.mockResolvedValue(response)
  expect(
    await runCli(["node", "nlbcli", "--non-interactive", "cards", "list"])
  ).toBe(EXIT_CODES.network)
  expect(stdout).not.toHaveBeenCalled()
})

test("invalid report files use the bank response exit code", async () => {
  fetchMock
    .mockResolvedValueOnce(new Response(balances))
    .mockResolvedValueOnce(new Response("<html>No report</html>"))
  expect(
    await runCli([
      "node",
      "nlbcli",
      "--non-interactive",
      "accounts",
      "transactions",
      account,
      "--format",
      "xls",
    ])
  ).toBe(EXIT_CODES.bankResponse)
  expect(stdout).not.toHaveBeenCalled()
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining("valid XLS file"))
})

test.each([
  500, 503,
])("HTTP %s errors are invalid bank responses", async (status) => {
  fetchMock.mockResolvedValue(new Response("Bank error", { status }))
  expect(
    await runCli(["node", "nlbcli", "--non-interactive", "accounts", "list"])
  ).toBe(EXIT_CODES.bankResponse)
  expect(stdout).not.toHaveBeenCalled()
})

test("unrecognized balance pages fail instead of succeeding with no data", async () => {
  fetchMock
    .mockResolvedValueOnce(new Response(balances))
    .mockResolvedValueOnce(new Response("<html>Unexpected page</html>"))
  expect(
    await runCli([
      "node",
      "nlbcli",
      "--non-interactive",
      "accounts",
      "balance",
      account,
      "--format",
      "json",
    ])
  ).toBe(EXIT_CODES.bankResponse)
  expect(stdout).not.toHaveBeenCalled()
})

test("an unrecognized session validation page is an invalid bank response", async () => {
  fetchMock.mockResolvedValue(new Response("<html>Service unavailable</html>"))
  expect(
    await runCli(["node", "nlbcli", "--non-interactive", "cards", "list"])
  ).toBe(EXIT_CODES.bankResponse)
  expect(stdout).not.toHaveBeenCalled()
})

test("an authenticated balance page with no products is a successful empty list", async () => {
  fetchMock.mockImplementation(() =>
    Promise.resolve(new Response('<div id="main_Balances"></div>'))
  )
  expect(
    await runCli(["node", "nlbcli", "--non-interactive", "cards", "list"])
  ).toBe(EXIT_CODES.success)
  expect(stdout.mock.calls).toEqual([["Cards:"]])
})

test("empty transaction tables produce parseable JSON", async () => {
  fetchMock
    .mockResolvedValueOnce(new Response(balances))
    .mockResolvedValueOnce(new Response("<table><tbody></tbody></table>"))
  expect(
    await runCli([
      "node",
      "nlbcli",
      "--non-interactive",
      "accounts",
      "transactions",
      account,
      "--format",
      "json",
    ])
  ).toBe(EXIT_CODES.success)
  expect(
    JSON.parse(stdout.mock.calls.map(([value]) => value).join(""))
  ).toEqual([])
  expect(stderr).toHaveBeenCalledWith("No transactions found.")
})
