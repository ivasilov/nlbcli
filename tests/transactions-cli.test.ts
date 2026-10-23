import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { build } from "tsdown"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "vitest"
import {
  headers,
  jsonRows,
  readTransactionExport,
  rows,
  transactionHtml,
  transactionXls,
} from "./transaction-fixtures"

let buildDirectory: string
let directory: string
let preload: string
let cli: string

beforeAll(async () => {
  // Keep the bundle beneath the project so its external dependencies resolve.
  buildDirectory = fs.mkdtempSync(path.join(process.cwd(), ".cli-test-"))
  await build({
    config: false,
    entry: ["src/index.ts"],
    outDir: buildDirectory,
    dts: false,
    logLevel: "silent",
  })
  cli = path.join(buildDirectory, "index.mjs")
  preload = path.join(buildDirectory, "mock-fetch.mjs")
  fs.writeFileSync(
    preload,
    `
globalThis.fetch = async (url) => {
  if (new URL(url).pathname === "/Home/Balances") return new Response('<html><div id="main_Balances">Saved session</div></html>');
  return new Response(Buffer.from(process.env.NLB_TEST_BODY, "base64"), {
    headers: { "content-disposition": 'attachment; filename="bank-name.xls"' }
  });
};
`
  )
})

beforeEach(() => {
  directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "nlbcli-cli-"))
  )
  const profileDirectory = path.join(
    directory,
    ".nlbcli",
    "profiles",
    "default"
  )
  fs.mkdirSync(profileDirectory, { recursive: true })
  fs.mkdirSync(path.join(directory, "nested"))
  fs.writeFileSync(
    path.join(profileDirectory, "session.json"),
    JSON.stringify({ cookie: "session=test", username: "test" })
  )
})

afterEach(() => fs.rmSync(directory, { recursive: true, force: true }))
afterAll(() => fs.rmSync(buildDirectory, { recursive: true, force: true }))

function runCli(format: string, body: Buffer | string, output?: string) {
  const args = [
    "--import",
    preload,
    cli,
    "accounts",
    "transactions",
    "account-id",
    "--format",
    format,
  ]
  if (output !== undefined) {
    args.push("--output", output)
  }
  return spawnSync(process.execPath, args, {
    cwd: directory,
    env: {
      ...process.env,
      HOME: directory,
      NLB_TEST_BODY: Buffer.from(body).toString("base64"),
      NO_COLOR: "1",
    },
    encoding: "utf-8",
  })
}

test.each([
  "xls",
  "csv",
  "json",
])("CLI writes %s to the exact relative --output path with progress only on stderr", (format) => {
  const output = "nested/exact destination.result"
  const result = runCli(
    format,
    format === "xls" ? transactionXls() : transactionHtml(),
    output
  )

  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toBe("")
  expect(result.stderr).toContain("Using saved session.")
  expect(result.stderr).toContain(`SAVED: ${path.join(directory, output)}`)
  expect(fs.existsSync(path.join(directory, "downloads"))).toBe(false)
  expect(fs.readdirSync(path.join(directory, "nested"))).toEqual([
    "exact destination.result",
  ])
  const contents = fs.readFileSync(path.join(directory, output))
  expect(readTransactionExport(format, contents)).toEqual(
    format === "json" ? jsonRows : [headers, ...rows]
  )
})

test.each([
  "xls",
  "csv",
  "json",
])("CLI fails for HTML login responses (%s) without creating a destination", (format) => {
  const result = runCli(
    format,
    '<html><body><input type="password"></body></html>',
    "nested/export"
  )

  expect(result.status).not.toBe(0)
  expect(result.stdout).toBe("")
  expect(result.stderr).toContain("No valid saved session")
  expect(fs.readdirSync(path.join(directory, "nested"))).toEqual([])
  expect(fs.existsSync(path.join(directory, "downloads"))).toBe(false)
})

test.each([
  "csv",
  "json",
])("CLI keeps %s stdout free of session progress without --output", (format) => {
  const result = runCli(format, transactionHtml())

  expect(result.status, result.stderr).toBe(0)
  expect(result.stderr).toContain("Using saved session.")
  expect(result.stdout).not.toContain("Using saved session.")
  if (format === "json") {
    expect(JSON.parse(result.stdout)).toEqual(jsonRows)
  } else {
    expect(result.stdout).toContain(`${headers.join(",")}\n`)
  }
})
