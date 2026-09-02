import { afterEach, describe, expect, test, vi } from "vitest"
import { cmdAccountTransactions } from "../src/commands/accounts"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("cmdAccountTransactions", () => {
  test("rejects HTML returned for an XLS export", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
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
