import { Command } from "@effect/cli"
import { NodeContext } from "@effect/platform-node"
import { Effect, Exit } from "effect"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { cmdLogin, getSession } from "../src/auth"
import { command } from "../src/cli"

vi.mock("../src/auth", () => ({
  cmdLogin: vi.fn().mockResolvedValue(undefined),
  getSession: vi.fn().mockResolvedValue("session=selected"),
  prompt: vi.fn().mockResolvedValue("prompted-user"),
}))
vi.mock("../src/commands/accounts", () => ({
  cmdListAccounts: vi.fn().mockResolvedValue([]),
  cmdAccountBalance: vi.fn().mockResolvedValue({}),
  cmdAccountReservations: vi.fn().mockResolvedValue([]),
  cmdAccountTransactions: vi.fn().mockResolvedValue(null),
}))
vi.mock("../src/commands/cards", () => ({
  cmdListCards: vi.fn().mockResolvedValue([]),
  cmdCardBalance: vi.fn().mockResolvedValue({}),
  cmdCardTransactions: vi.fn().mockResolvedValue([]),
}))

const cli = Command.run(command, { name: "nlbcli", version: "test" })

function run(args: string[]) {
  return Effect.runPromiseExit(
    cli(["node", "nlbcli", ...args]).pipe(Effect.provide(NodeContext.layer))
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, "log").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

test("root profile reaches login", async () => {
  const result = await run(["--profile", "work", "login", "--username", "bob"])
  expect(Exit.isSuccess(result)).toBe(true)
  expect(cmdLogin).toHaveBeenCalledExactlyOnceWith("work", "bob")
})

test.each([
  ["accounts", "list"],
  ["accounts", "balance", "account-id"],
  [
    "accounts",
    "transactions",
    "account-id",
    "--format",
    "json",
    "--start",
    "01.01.2026",
  ],
  ["accounts", "reservations", "account-id"],
  ["cards", "list"],
  ["cards", "balance", "card-id"],
  ["cards", "transactions", "card-id"],
])("root profile reaches %j", async (...args) => {
  const result = await run(["--profile", "work", ...args])
  expect(Exit.isSuccess(result)).toBe(true)
  expect(getSession).toHaveBeenCalledExactlyOnceWith("work")
})

test("omitting --profile selects default", async () => {
  expect(Exit.isSuccess(await run(["cards", "list"]))).toBe(true)
  expect(getSession).toHaveBeenCalledExactlyOnceWith("default")
})

test.each([
  "../outside",
  "/absolute",
  "work/other",
  "work\\other",
  "..",
  "work\n",
])("rejects invalid root profile %j before running a handler", async (profile) => {
  expect(
    Exit.isFailure(
      await run(["--profile", profile, "login", "--username", "bob"])
    )
  ).toBe(true)
  expect(cmdLogin).not.toHaveBeenCalled()
  expect(getSession).not.toHaveBeenCalled()
})
