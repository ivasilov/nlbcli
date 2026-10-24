import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Command } from "@effect/cli"
import { NodeContext } from "@effect/platform-node"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { getSession } from "../src/auth"
import { command, runCli } from "../src/cli"
import { EXIT_CODES } from "../src/errors"
import { loadState, saveCookies } from "../src/state"

vi.mock("../src/state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/state")>()),
  loadState: vi.fn(),
  saveCookies: vi.fn(),
}))

const cli = Command.run(command, { name: "nlbcli", version: "test" })

const fixture = (name: string) =>
  fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf-8")
const session = JSON.parse(fixture("session.json")) as {
  cookie: string
  username: string
}
const login = fixture("login.html")
const pagerPattern = /<ul[\s\S]*<\/ul>/
let directory: string
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>
let stdout: ReturnType<typeof vi.spyOn<typeof console, "log">>

function run(...args: string[]) {
  return Effect.runPromise(
    cli(["node", "nlbcli", "--profile", "redacted", ...args]).pipe(
      Effect.provide(NodeContext.layer)
    )
  )
}

function runExit(...args: string[]) {
  return runCli(["node", "nlbcli", "--profile", "redacted", ...args])
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "nlbcli-cli-"))
  fetchMock = vi.fn<typeof fetch>()
  vi.stubGlobal("fetch", fetchMock)
  vi.mocked(loadState).mockImplementation((profile = "default") =>
    profile === "redacted" ? session : null
  )
  stdout = vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  fs.rmSync(directory, { recursive: true, force: true })
})

describe.each(["cards", "accounts"])("%s transaction CLI", (resource) => {
  const id = resource === "cards" ? "00000000/0000" : "000-0000000000-00MKD"
  const flags = [
    "--start",
    "01.01.2024",
    "--end",
    "31.01.2024",
    "--non-interactive",
  ]

  function mockPages(empty = false) {
    fetchMock.mockResolvedValueOnce(
      new Response('<html><div id="main_Balances">REDACTED</div></html>')
    )
    if (empty) {
      fetchMock.mockResolvedValueOnce(new Response(fixture("cards/empty.html")))
    } else {
      fetchMock.mockResolvedValueOnce(
        new Response(fixture(`${resource}/page-1.html`))
      )
      fetchMock.mockResolvedValueOnce(
        new Response(fixture(`${resource}/page-2.html`))
      )
    }
  }

  test.each([
    "default",
    "new",
    "existing",
  ])("skips an empty XLS report successfully (%s destination)", async (destination) => {
    mockPages(true)
    vi.spyOn(process, "cwd").mockReturnValue(directory)
    const output = path.join(directory, "empty.xls")
    if (destination === "existing") {
      fs.writeFileSync(output, "previous export")
    }

    expect(
      await runExit(
        resource,
        "transactions",
        id,
        ...flags,
        "--format",
        "xls",
        ...(destination === "default" ? [] : ["--output", output])
      )
    ).toBe(EXIT_CODES.success)
    expect(stdout).not.toHaveBeenCalled()
    expect(console.error).toHaveBeenCalledWith("No transactions found.")
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fs.readdirSync(directory)).toEqual(
      destination === "existing" ? ["empty.xls"] : []
    )
    if (destination === "existing") {
      expect(fs.readFileSync(output, "utf-8")).toBe("previous export")
    }
  })

  test.each([
    "request",
    "download",
  ])("reports an actionable XLS error when the bank fails during %s", async (stage) => {
    fetchMock.mockResolvedValueOnce(
      new Response('<html><div id="main_Balances">REDACTED</div></html>')
    )
    fetchMock.mockResolvedValueOnce(
      new Response(fixture(`${resource}/page-1.html`))
    )
    if (stage === "download") {
      const area = resource === "accounts" ? "Retail" : "Cms"
      fetchMock.mockResolvedValueOnce(
        new Response(`<iframe src="/${area}/RenderReport/test"></iframe>`)
      )
    }
    fetchMock.mockResolvedValueOnce(new Response("failure", { status: 500 }))
    const output = path.join(directory, "transactions.xls")

    expect(
      await runExit(
        resource,
        "transactions",
        id,
        "--non-interactive",
        "--start",
        "01.09.2026",
        "--end",
        "30.09.2026",
        "--format",
        "xls",
        "--output",
        output
      )
    ).toBe(EXIT_CODES.bankResponse)
    expect(stdout).not.toHaveBeenCalled()
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("HTTP 500")
    )
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Try --format tab, csv, or json.")
    )
    expect(fs.readdirSync(directory)).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(stage === "request" ? 3 : 4)
  })

  test.each([
    "tab",
    "csv",
    "json",
  ])("accepts all options and prints %s across pages", async (format) => {
    mockPages()
    await run(resource, "transactions", id, ...flags, "--format", format)
    expect(loadState).toHaveBeenCalledExactlyOnceWith("redacted")
    expect(fetchMock).toHaveBeenCalledTimes(3)
    for (const [url, options] of fetchMock.mock.calls) {
      expect(options?.headers).toMatchObject({ Cookie: session.cookie })
      expect(String(url)).not.toContain("/Account/")
    }
    const content = stdout.mock.calls.map(([line]) => line).join("\n")
    expect(content).not.toContain("Using saved session")
    if (format === "json") {
      const rows = JSON.parse(content)
      expect(rows).toHaveLength(resource === "cards" ? 3 : 2)
      expect(rows[0].date).toBe("2024-01-31")
      expect(rows.at(-1).date).toBe("2024-01-01")
    } else {
      expect(content).toContain(format === "csv" ? "2024-01-31" : "31.01.2024")
      expect(content).toContain(format === "csv" ? "2024-01-01" : "01.01.2024")
      expect(content).toContain(format === "csv" ? "," : "\t")
    }
  })

  test.each(["csv", "json", "xls"])("writes %s to --output", async (format) => {
    if (format === "xls") {
      fetchMock.mockResolvedValueOnce(
        new Response('<html><div id="main_Balances">REDACTED</div></html>')
      )
      fetchMock.mockResolvedValueOnce(
        new Response(fixture(`${resource}/page-1.html`))
      )
      fetchMock.mockResolvedValueOnce(
        new Response(fixture("cards/report.xls"), {
          headers: { "content-type": "application/vnd.ms-excel" },
        })
      )
    } else {
      mockPages()
    }
    const output = path.join(directory, `export.${format}`)
    await run(
      resource,
      "transactions",
      id,
      ...flags,
      "--format",
      format,
      "--output",
      output
    )
    expect(fs.existsSync(output)).toBe(true)
    expect(console.error).toHaveBeenCalledWith(
      `SAVED: ${output} (${fs.statSync(output).size} bytes)`
    )
  })

  test.each([
    "tab",
    "csv",
    "json",
  ])("prints the account-compatible empty result for %s", async (format) => {
    mockPages(true)
    await run(resource, "transactions", id, ...flags, "--format", format)
    expect(console.error).toHaveBeenCalledWith("No transactions found.")
    if (format === "json") {
      expect(stdout).toHaveBeenCalledExactlyOnceWith("[]")
    } else if (format === "csv") {
      expect(stdout).toHaveBeenCalledExactlyOnceWith(
        resource === "cards"
          ? "date,description,amount,currency"
          : "date,recipient,description,status,amount,fee,balance"
      )
    } else {
      expect(stdout).not.toHaveBeenCalled()
    }
  })

  test.each([
    "csv",
    "json",
  ])("a malformed later page preserves an existing %s export", async (format) => {
    const output = path.join(directory, `existing.${format}`)
    fs.writeFileSync(output, "previous export")
    fetchMock
      .mockResolvedValueOnce(
        new Response('<html><div id="main_Balances">REDACTED</div></html>')
      )
      .mockResolvedValueOnce(new Response(fixture(`${resource}/page-1.html`)))
      .mockResolvedValueOnce(
        new Response(
          fixture(`${resource}/page-2.html`).replace("-89.01", "NaN")
        )
      )
    expect(
      await runExit(
        resource,
        "transactions",
        id,
        ...flags,
        "--format",
        format,
        "--output",
        output
      )
    ).toBe(EXIT_CODES.bankResponse)
    expect(fs.readFileSync(output, "utf-8")).toBe("previous export")
    expect(fs.readdirSync(directory)).toEqual([path.basename(output)])
    expect(stdout).not.toHaveBeenCalled()
  })

  test.each([
    ["--start", "31.02.2024"],
    ["--end", "31.12.2023"],
    ["--format", "xml"],
    ["--output", ""],
  ])("validates %s before looking up a session", async (flag, value) => {
    const args = [
      "--start",
      "01.01.2024",
      "--end",
      "31.01.2024",
      "--format",
      "json",
      "--output",
      path.join(directory, "output.json"),
    ]
    args[args.indexOf(flag) + 1] = value
    expect(
      await runExit(resource, "transactions", id, ...args, "--non-interactive")
    ).toBe(EXIT_CODES.arguments)
    expect(loadState).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test.each([
    302, 401, 403, 200,
  ])("fails on an expired named profile (HTTP %s) without sending a push", async (status) => {
    fetchMock.mockResolvedValueOnce(
      new Response(status === 200 ? login : null, { status })
    )
    expect(
      await runExit(resource, "transactions", id, ...flags, "--format", "json")
    ).toBe(EXIT_CODES.authentication)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "nlbcli --profile redacted login --username 'REDACTED'"
      )
    )
    expect(loadState).toHaveBeenCalledExactlyOnceWith("redacted")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(stdout).not.toHaveBeenCalled()
  })

  test("does not fall back to a different profile when the requested session is missing", async () => {
    vi.mocked(loadState).mockImplementation((profile = "default") =>
      profile === "default" ? session : null
    )
    expect(await runExit(resource, "transactions", id, ...flags)).toBe(
      EXIT_CODES.authentication
    )
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "nlbcli --profile redacted login --username <user>"
      )
    )
    expect(loadState).toHaveBeenCalledExactlyOnceWith("redacted")
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

test("account filters are retained across every page", async () => {
  fetchMock
    .mockResolvedValueOnce(
      new Response('<html><div id="main_Balances">REDACTED</div></html>')
    )
    .mockResolvedValueOnce(new Response(fixture("accounts/page-1.html")))
    .mockResolvedValueOnce(new Response(fixture("accounts/page-2.html")))
  await run(
    "accounts",
    "transactions",
    "000-0000000000-00MKD",
    "--start",
    "01.01.2024",
    "--end",
    "31.01.2024",
    "--non-interactive",
    "--type",
    "out",
    "--name",
    "REDACTED",
    "--format",
    "json"
  )
  for (const [, options] of fetchMock.mock.calls.slice(1)) {
    expect(
      Object.fromEntries(new URLSearchParams(String(options?.body)))
    ).toMatchObject({
      DateFrom: "01.01.2024",
      DateTo: "31.01.2024",
      Direction: "-1",
      OtherPartyName: "REDACTED",
    })
  }
})

test("account transactions start at bank page zero instead of returning a false empty result", async () => {
  const requested: string[] = []
  fetchMock.mockImplementation((url, options) => {
    if (new URL(String(url)).pathname === "/Home/Balances") {
      return Promise.resolve(new Response('<div id="main_Balances"></div>'))
    }
    const page =
      new URLSearchParams(String(options?.body)).get("PageNumber") ?? ""
    requested.push(page)
    return Promise.resolve(
      new Response(
        page === "0"
          ? fixture("accounts/page-1.html").replace(pagerPattern, "")
          : fixture("no-data-transactions.html")
      )
    )
  })
  expect(
    await runExit(
      "accounts",
      "transactions",
      "account-id",
      "--non-interactive",
      "--format",
      "json"
    )
  ).toBe(EXIT_CODES.success)
  expect(
    JSON.parse(stdout.mock.calls.map(([line]) => line).join(""))
  ).toHaveLength(1)
  expect(requested).toEqual(["0"])
})

test("account transactions follow the bank's zero-based pager even for short pages", async () => {
  const requested: number[] = []
  fetchMock.mockImplementation((url, options) => {
    if (new URL(String(url)).pathname === "/Home/Balances") {
      return Promise.resolve(new Response('<div id="main_Balances"></div>'))
    }
    const page = Number(
      new URLSearchParams(String(options?.body)).get("PageNumber")
    )
    requested.push(page)
    return Promise.resolve(
      new Response(
        page < 3
          ? fixture("accounts/live-transactions.html").replace(
              "31.01.2024",
              `${31 - page}.01.2024`
            )
          : fixture("no-data-transactions.html")
      )
    )
  })
  expect(
    await runExit(
      "accounts",
      "transactions",
      "account-id",
      "--non-interactive",
      "--format",
      "json"
    )
  ).toBe(EXIT_CODES.success)
  expect(
    JSON.parse(stdout.mock.calls.map(([line]) => line).join(""))
  ).toHaveLength(3)
  expect(requested).toEqual([0, 1, 2])
})

test.each([
  ["accounts/page-1.html", "000-0000000001-00MKD"],
  ["no-data-transactions.html", "000-0000000001-00MKD"],
  ["accounts/page-1.html", ""],
  ["no-data-transactions.html", ""],
])("rejects a bank response without the requested account (%s, %j)", async (response, returnedAccount) => {
  fetchMock
    .mockResolvedValueOnce(new Response('<div id="main_Balances"></div>'))
    .mockResolvedValueOnce(
      new Response(
        `<h4 class="widget-title"><strong>${returnedAccount}</strong></h4>` +
          fixture(response)
      )
    )
  expect(
    await runExit(
      "accounts",
      "transactions",
      "000-0000000000-00MKD",
      "--non-interactive",
      "--format",
      "json"
    )
  ).toBe(EXIT_CODES.bankResponse)
  expect(stdout).not.toHaveBeenCalled()
  expect(console.error).toHaveBeenCalledWith(
    expect.stringContaining("different account")
  )
})

test("interactive reauthentication saves the replacement session to the selected profile", async () => {
  vi.useFakeTimers()
  fetchMock
    .mockResolvedValueOnce(new Response(null, { status: 302 }))
    .mockResolvedValueOnce(
      new Response("<html>REDACTED login</html>", {
        headers: { "set-cookie": "session=REDACTED_NEW; Path=/" },
      })
    )
    .mockResolvedValueOnce(
      Response.json({ Success: true, Message: "REDACTED_LOGIN_ID" })
    )
    .mockResolvedValueOnce(Response.json({ Success: true }))
    .mockResolvedValueOnce(Response.json({ UserAuthenticated: true }))
  const pending = getSession("redacted")
  await vi.runAllTimersAsync()
  expect(await pending).toBe("session=REDACTED_NEW")
  expect(saveCookies).toHaveBeenCalledExactlyOnceWith(
    "redacted",
    "session=REDACTED_NEW",
    "REDACTED"
  )
})
