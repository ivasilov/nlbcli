import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

let home: string
let state: typeof import("../src/state")
let auth: typeof import("../src/auth")

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nlbcli-profiles-"))
  vi.stubEnv("HOME", home)
  vi.resetModules()
  state = await import("../src/state")
  auth = await import("../src/auth")
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new Error("Unexpected fetch"))
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  fs.rmSync(home, { recursive: true, force: true })
})

function permissions(file: string): number {
  // biome-ignore lint/suspicious/noBitwiseOperators: Mask off file type bits to inspect POSIX permissions.
  return fs.statSync(file).mode & 0o777
}

describe("profile storage", () => {
  test("keeps cookies and usernames separate when a profile is overwritten", () => {
    state.saveCookies("personal", "session=alice", "alice")
    state.saveCookies("work", "session=bob", "bob")
    state.saveCookies("personal", "session=alice-new", "alice")

    expect(state.loadState("personal")).toEqual({
      cookie: "session=alice-new",
      username: "alice",
    })
    expect(state.loadState("work")).toEqual({
      cookie: "session=bob",
      username: "bob",
    })
    expect(state.getSessionFile("work")).toBe(
      path.join(home, ".nlbcli", "profiles", "work", "session.json")
    )
    expect(state.loadState("missing")).toBeNull()
  })

  test("creates private directories and session files, including on overwrite", () => {
    state.saveCookies("personal", "session=alice", "alice")
    const file = state.getSessionFile("personal")
    const directory = path.dirname(file)
    expect(permissions(directory)).toBe(0o700)
    expect(permissions(file)).toBe(0o600)

    fs.chmodSync(directory, 0o755)
    fs.chmodSync(file, 0o644)
    state.saveCookies("personal", "session=alice-new", "alice")
    expect(permissions(directory)).toBe(0o700)
    expect(permissions(file)).toBe(0o600)
  })

  test.each([
    "personal",
    "work-2",
    "Account_1",
    "bank.main",
  ])("accepts profile %s", (profile) => {
    expect(state.validateProfile(profile)).toBe(profile)
  })

  test.each([
    "",
    ".",
    "..",
    "../other",
    "work/../../other",
    "/tmp/other",
    "work/other",
    "work\\other",
    "C:\\other",
    "two words",
    "work\n",
    "work\0",
    "%2e%2e",
    "~",
  ])("rejects invalid profile %j before reading or writing", (profile) => {
    expect(() => state.getSessionFile(profile)).toThrow("Invalid profile name")
    expect(() => state.loadState(profile)).toThrow("Invalid profile name")
    expect(() => state.saveCookies(profile, "session=test", "user")).toThrow(
      "Invalid profile name"
    )
    expect(fs.existsSync(path.join(home, ".nlbcli"))).toBe(false)
  })

  test("does not follow a profile directory symlink", () => {
    const target = path.join(home, "outside")
    fs.mkdirSync(target)
    const profileDirectory = path.dirname(state.getSessionFile("linked"))
    fs.mkdirSync(path.dirname(profileDirectory), { recursive: true })
    fs.symlinkSync(target, profileDirectory)

    expect(() => state.loadState("linked")).toThrow("symbolic link")
    expect(() => state.saveCookies("linked", "session=test", "user")).toThrow(
      "symbolic link"
    )
    expect(fs.readdirSync(target)).toEqual([])
  })

  test("does not read or overwrite a session symlink", () => {
    state.saveCookies("personal", "session=alice", "alice")
    const file = state.getSessionFile("personal")
    const target = path.join(home, "outside.json")
    fs.renameSync(file, target)
    fs.symlinkSync(target, file)

    expect(state.loadState("personal")).toBeNull()
    expect(() => state.saveCookies("personal", "session=new", "new")).toThrow()
    expect(JSON.parse(fs.readFileSync(target, "utf-8"))).toEqual({
      cookie: "session=alice",
      username: "alice",
    })
  })

  test("ignores the legacy shared session and handles malformed profile state", () => {
    fs.mkdirSync(path.join(home, ".nlbcli"))
    fs.writeFileSync(
      path.join(home, ".nlbcli", "cookies.json"),
      JSON.stringify({ cookie: "legacy", username: "legacy-user" })
    )
    expect(state.loadState("default")).toBeNull()
    expect(state.loadState("work")).toBeNull()

    state.saveCookies("work", "session=bob", "bob")
    fs.writeFileSync(state.getSessionFile("work"), "invalid JSON")
    expect(state.loadState("work")).toBeNull()
  })
  test.each([
    "null",
    "{}",
    '{"cookie":""}',
    '{"cookie":"   "}',
    '{"cookie":123}',
    '{"cookie":{"session":"test"}}',
  ])("treats invalid session data as unauthenticated: %s", (contents) => {
    state.saveCookies("work", "session=test", "bob")
    fs.writeFileSync(state.getSessionFile("work"), contents)
    expect(state.loadState("work")).toBeNull()
  })
})

function pushResponse(url: string | URL, init?: RequestInit): Response {
  const endpoint = new URL(url).pathname
  if (endpoint === "/Account/Login") {
    return new Response("", {
      headers: { "set-cookie": "session=bootstrap" },
    })
  }
  if (endpoint === "/Account/SendLoginPushMessage") {
    return Response.json({ Success: true, Message: "request-id" })
  }
  if (endpoint === "/Account/CheckPushCallbackStatus") {
    return Response.json({ Success: true })
  }
  if (endpoint === "/Account/LoginUserNamePush") {
    const username = new URLSearchParams(String(init?.body)).get("UserName")
    return Response.json(
      { UserAuthenticated: true },
      { headers: { "set-cookie": `session=${username}` } }
    )
  }
  throw new Error(`Unexpected endpoint: ${endpoint}`)
}

function mockPushLogin() {
  const fetchMock = vi.fn((url: string | URL, init?: RequestInit) =>
    Promise.resolve(pushResponse(url, init))
  )
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

describe("profile authentication", () => {
  test("non-interactive mode never falls back from a missing profile", async () => {
    state.saveCookies("personal", "session=alice", "alice")
    await expect(
      auth.getSession("work", undefined, { nonInteractive: true })
    ).rejects.toThrow("nlbcli --profile work login --username <user>")
    expect(fetch).not.toHaveBeenCalled()
    expect(state.loadState("personal")).toEqual({
      cookie: "session=alice",
      username: "alice",
    })
  })

  test("non-interactive mode rejects an expired profile without refreshing it", async () => {
    state.saveCookies("personal", "session=alice", "alice")
    state.saveCookies("work", "session=bob-old", "bob")
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 302 }))
    vi.stubGlobal("fetch", fetchMock)
    await expect(
      auth.getSession("work", undefined, { nonInteractive: true })
    ).rejects.toThrow("nlbcli --profile work login --username 'bob'")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1].headers.Cookie).toBe("session=bob-old")
    expect(state.loadState("work")).toEqual({
      cookie: "session=bob-old",
      username: "bob",
    })
    expect(state.loadState("personal")).toEqual({
      cookie: "session=alice",
      username: "alice",
    })
  })

  test("non-interactive mode reuses only the selected profile's valid cookie", async () => {
    state.saveCookies("personal", "session=alice", "alice")
    state.saveCookies("work", "session=bob", "bob")
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('<div id="main_Balances"></div>'))
    vi.stubGlobal("fetch", fetchMock)
    expect(
      await auth.getSession("work", undefined, { nonInteractive: true })
    ).toBe("session=bob")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1].headers.Cookie).toBe("session=bob")
  })

  test("logs two users into separate profiles", async () => {
    vi.useFakeTimers()
    mockPushLogin()
    const personalLogin = auth.cmdLogin("personal", "alice")
    await vi.runAllTimersAsync()
    await personalLogin
    const workLogin = auth.cmdLogin("work", "bob")
    await vi.runAllTimersAsync()
    await workLogin

    expect(state.loadState("personal")).toEqual({
      cookie: "session=alice",
      username: "alice",
    })
    expect(state.loadState("work")).toEqual({
      cookie: "session=bob",
      username: "bob",
    })
  })

  test("validates each selected profile using only its own cookie", async () => {
    state.saveCookies("personal", "session=alice", "alice")
    state.saveCookies("work", "session=bob", "bob")
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response('<div id="main_Balances"></div>'))
      )
    vi.stubGlobal("fetch", fetchMock)

    expect(await auth.getSession("personal")).toBe("session=alice")
    expect(await auth.getSession("work")).toBe("session=bob")
    expect(fetchMock.mock.calls.map(([, init]) => init.headers.Cookie)).toEqual(
      ["session=alice", "session=bob"]
    )
  })

  test("refreshes an expired profile using its saved username only", async () => {
    vi.useFakeTimers()
    state.saveCookies("personal", "session=alice", "alice")
    state.saveCookies("work", "session=bob-old", "bob")
    const fetchMock = mockPushLogin()
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302 }))

    const refresh = auth.getSession("work")
    await vi.runAllTimersAsync()
    expect(await refresh).toBe("session=bob")
    expect(state.loadState("work")).toEqual({
      cookie: "session=bob",
      username: "bob",
    })
    expect(state.loadState("personal")).toEqual({
      cookie: "session=alice",
      username: "alice",
    })
    const loginRequest = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/Account/LoginUserNamePush")
    )
    expect(
      new URLSearchParams(String(loginRequest?.[1]?.body)).get("UserName")
    ).toBe("bob")
  })

  test("a missing profile never falls back to another profile", async () => {
    state.saveCookies("personal", "session=alice", "alice")
    await expect(auth.getSession("work")).rejects.toThrow(
      "nlbcli --profile work login --username <user>"
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  test("invalid profiles are rejected before any authentication request", async () => {
    await expect(auth.cmdLogin("../outside", "alice")).rejects.toThrow(
      "Invalid profile name"
    )
    await expect(auth.getSession("../outside")).rejects.toThrow(
      "Invalid profile name"
    )
    expect(fetch).not.toHaveBeenCalled()
  })
})
