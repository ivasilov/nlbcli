import { afterEach, describe, expect, test, vi } from "vitest"
import { openAuthenticatedPath } from "../src/auth"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("openAuthenticatedPath", () => {
  test("uses the target page itself to validate a healthy session", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response("<form id='form_EntryForm'></form>", { status: 200 })
      )
    )
    const login = vi.fn(() => Promise.resolve("fresh=session"))
    const persist = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const result = await openAuthenticatedPath("/DpsTransferFunds/Order", {
      load: () => ({ cookie: "saved=session", username: "test-user" }),
      login,
      persist,
    })

    expect(result.response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "/DpsTransferFunds/Order"
    )
    expect(String(fetchMock.mock.calls[0][0])).not.toContain("Home/Balances")
    expect(login).not.toHaveBeenCalled()
    expect(persist).toHaveBeenCalledWith("saved=session", "test-user")
  })

  test("retries only the original target after an expired-session login", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          headers: { location: "/Account/Login" },
          status: 302,
        })
      )
      .mockResolvedValueOnce(
        new Response("<form id='form_EntryForm'></form>", { status: 200 })
      )
    const login = vi.fn(() => Promise.resolve("fresh=session"))
    const persist = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    await openAuthenticatedPath("/DpsTransferFunds/PP50Order", {
      load: () => ({ cookie: "expired=session", username: "test-user" }),
      login,
      persist,
    })

    expect(login).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(
      fetchMock.mock.calls.map((call) => new URL(String(call[0])).pathname)
    ).toEqual(["/DpsTransferFunds/PP50Order", "/DpsTransferFunds/PP50Order"])
    expect(persist).toHaveBeenCalledWith("fresh=session", "test-user")
  })
})
