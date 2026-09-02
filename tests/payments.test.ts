import { afterEach, describe, expect, test, vi } from "vitest"
import {
  AmbiguousPaymentError,
  confirmPaymentInteractively,
  executePayment,
  normalizeAmount,
  normalizeDestinationAccount,
  type PaymentSummary,
  type PP30PaymentRequest,
  type PP50PaymentRequest,
  type PP53PaymentRequest,
  preparePayment,
  validateValueDate,
} from "../src/commands/payments"
import { NlbHttpClient } from "../src/http"

interface RecordedRequest {
  body: string
  cookie: string
  method: string
  path: string
}

const TODAY = new Date(2026, 8, 2)
const SOURCE_ACCOUNT = "210-0000000001-01MKD"

function paymentForm(type: "pp30" | "pp50" | "pp53"): string {
  const recipientFields =
    type === "pp53"
      ? ""
      : `
        <textarea name="PurposeDescription"></textarea>
        <input name="OrderingPartyReferenceNumber" value="">
        <input name="OtherPartyName" value="">
        <input name="OtherPartyAddress" value="">
        <input name="DestinationAccount" value="">
        <input name="OtherPartyBank" value="">
      `
  const typeFields = {
    pp30: `
      <input name="Amount" value="">
      <input name="OtherPartyReferenceNumber" value="">
      <select name="PurposeCode">
        <option value=""></option>
        <option value="289">289 Other transfers</option>
      </select>
    `,
    pp50: `
      <input name="TaxId" value="payer-tax-id">
      <input name="Amount" value="">
      <input name="PayeeAccount" value="">
      <input name="BudgetaryAccount" value="">
      <input name="IncomeCodeAndProgram" value="">
    `,
    pp53: `
      <input name="TaxId" value="payer-tax-id">
      <input name="FolioNumber" value="">
      <input name="Amount" value="">
      <input name="NumberOfOrders" value="">
    `,
  }[type]

  return `
    <html><body>
      <form id="form_EntryForm" action="test">
        <input name="TemplateId" value="">
        <input name="TemplateName" value="">
        <input name="SaveAsNew" value="True">
        <input name="__RequestVerificationToken" value="form-token">
        <select name="OrderingPartyName"><option value="payer-id" selected>Payer</option></select>
        <input name="OrderingPartyAddress" value="Payer address">
        <select name="SourceAccount"><option value="${SOURCE_ACCOUNT}" selected>Account</option></select>
        <input name="OrderingPartyBank" value="NLB Bank">
        <input name="Currency" value="MKD">
        <input name="ValueDate" value="02.09.2026">
        ${recipientFields}
        ${typeFields}
      </form>
    </body></html>
  `
}

function makeFetch(
  type: "pp30" | "pp50" | "pp53",
  orderResponse = '<div id="ProcesStatusMessage">Order saved</div><a href="/PaymentOrders/Details/order-1">details</a>'
): { fetchMock: ReturnType<typeof vi.fn>; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = []
  const fetchMock = vi.fn(
    (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url
      )
      const method = init?.method ?? "GET"
      const body = init?.body?.toString() ?? ""
      const cookie = new Headers(init?.headers).get("cookie") ?? ""
      requests.push({ body, cookie, method, path: url.pathname })

      if (method === "GET") {
        return new Response(paymentForm(type), {
          headers: {
            "content-type": "text/html",
            "set-cookie": "__RequestVerificationToken=cookie-token; Path=/",
          },
          status: 200,
        })
      }
      if (url.pathname === "/Csp/RecipientDataAjax") {
        return Response.json({
          RecipientAddress: "Resolved address",
          RecipientBank: "Resolved bank",
          RecipientName: "Resolved recipient",
        })
      }
      if (url.pathname === "/Csp/ValidatePP50Account") {
        return Response.json({ Response: "724123", Success: true })
      }
      if (url.pathname === "/Csp/GetPiomResponse") {
        return Response.json({ NumberOfOrders: "3", TotalAmount: "1,250.50" })
      }
      if (url.pathname === "/DpsTransferFunds/GetLongRunningTaskStatus") {
        return Response.json({
          Completed: true,
          TransitionDescription: "Authorization completed successfully",
        })
      }
      return new Response(orderResponse, {
        headers: { "content-type": "text/html" },
        status: 200,
      })
    }
  )
  return { fetchMock, requests }
}

function openSession() {
  return async (path: string) => {
    const client = new NlbHttpClient("session=test")
    return { client, response: await client.get(path) }
  }
}

function pp30Request(): PP30PaymentRequest {
  return {
    amount: "125.5",
    destinationAccount: "300123456789012",
    purposeCode: "289",
    sourceAccount: SOURCE_ACCOUNT,
    type: "pp30",
    urgency: false,
    valueDate: "02.09.2026",
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("payment input validation", () => {
  test("normalizes destination accounts like the NLB form", () => {
    expect(normalizeDestinationAccount("300123456789012")).toBe(
      "300-1234567890-12"
    )
    expect(normalizeDestinationAccount("300-1234567890-12")).toBe(
      "300-1234567890-12"
    )
  })

  test("normalizes valid amounts and rejects unsafe values", () => {
    expect(normalizeAmount("1,250.5")).toBe("1250.50")
    expect(() => normalizeAmount("0")).toThrow("greater than 0")
    expect(() => normalizeAmount("1.234")).toThrow("at most 2 decimals")
  })

  test("rejects invalid and past value dates", () => {
    expect(validateValueDate("02.09.2026", TODAY)).toBe("02.09.2026")
    expect(() => validateValueDate("31.02.2027", TODAY)).toThrow(
      "valid calendar date"
    )
    expect(() => validateValueDate("01.09.2026", TODAY)).toThrow("past")
  })
})

describe("payment request budgets and payloads", () => {
  test("PP30 uses one form GET, one recipient lookup, and one order POST", async () => {
    const { fetchMock, requests } = makeFetch("pp30")
    vi.stubGlobal("fetch", fetchMock)

    const result = await executePayment(pp30Request(), "create", {
      openSession: openSession(),
      today: TODAY,
    })

    expect(result).toMatchObject({
      orderId: "order-1",
      status: "draft-created",
      type: "pp30",
    })
    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /DpsTransferFunds/Order",
      "POST /Csp/RecipientDataAjax",
      "POST /DpsTransferFunds/Order",
    ])
    expect(requests.some(({ path }) => path.includes("Home/Balances"))).toBe(
      false
    )
    expect(requests[1].cookie).toContain(
      "__RequestVerificationToken=cookie-token"
    )

    const submitted = new URLSearchParams(requests[2].body)
    expect(submitted.get("__RequestVerificationToken")).toBe("form-token")
    expect(submitted.get("SourceAccount")).toBe(SOURCE_ACCOUNT)
    expect(submitted.get("DestinationAccount")).toBe("300-1234567890-12")
    expect(submitted.get("OtherPartyName")).toBe("Resolved recipient")
    expect(submitted.get("Amount")).toBe("125.50")
    expect(submitted.get("PurposeCode")).toBe("289")
    expect(submitted.has("4")).toBe(true)
    expect(submitted.has("3")).toBe(false)
  })

  test("rejects an unavailable PP30 purpose code before JSON lookups", async () => {
    const { fetchMock, requests } = makeFetch("pp30")
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      preparePayment(
        { ...pp30Request(), purposeCode: "999" },
        { openSession: openSession(), today: TODAY }
      )
    ).rejects.toThrow("not offered")
    expect(requests).toHaveLength(1)
  })

  test("returns bank validation errors without refreshing HTML", async () => {
    const response = `
      <form id="form_EntryForm">
        <input class="input-validation-error" name="Amount">
        <span data-valmsg-for="Amount">Invalid amount</span>
      </form>
    `
    const { fetchMock, requests } = makeFetch("pp30", response)
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      executePayment(pp30Request(), "create", {
        openSession: openSession(),
        today: TODAY,
      })
    ).rejects.toThrow("Invalid amount")
    expect(requests.filter(({ method }) => method === "GET")).toHaveLength(1)
    expect(requests).toHaveLength(3)
  })

  test("PP50 skips derivation when an income code is supplied", async () => {
    const { fetchMock, requests } = makeFetch("pp50")
    vi.stubGlobal("fetch", fetchMock)
    const request: PP50PaymentRequest = {
      amount: "500",
      destinationAccount: "840000000000001",
      incomeCodeAndProgram: "724123",
      sourceAccount: SOURCE_ACCOUNT,
      type: "pp50",
      urgency: true,
      valueDate: "02.09.2026",
    }

    const result = await executePayment(request, "create", {
      openSession: openSession(),
      today: TODAY,
    })

    expect(result.status).toBe("draft-created")
    expect(requests.map(({ path }) => path)).toEqual([
      "/DpsTransferFunds/PP50Order",
      "/Csp/RecipientDataAjax",
      "/DpsTransferFunds/PP50Order",
    ])
    const submitted = new URLSearchParams(requests[2].body)
    expect(submitted.get("IncomeCodeAndProgram")).toBe("724123")
    expect(submitted.get("Urgency")).toBe("True")
  })

  test("PP50 performs no derivation lookup when optional tax fields are omitted", async () => {
    const { fetchMock, requests } = makeFetch("pp50")
    vi.stubGlobal("fetch", fetchMock)
    const request: PP50PaymentRequest = {
      amount: "500",
      destinationAccount: "840000000000001",
      sourceAccount: SOURCE_ACCOUNT,
      type: "pp50",
      urgency: false,
      valueDate: "02.09.2026",
    }

    const result = await executePayment(request, "create", {
      openSession: openSession(),
      today: TODAY,
    })

    expect(result.status).toBe("draft-created")
    expect(requests.map(({ path }) => path)).toEqual([
      "/DpsTransferFunds/PP50Order",
      "/Csp/RecipientDataAjax",
      "/DpsTransferFunds/PP50Order",
    ])
    const submitted = new URLSearchParams(requests[2].body)
    expect(submitted.get("IncomeCodeAndProgram")).toBe("")
  })

  test("PP50 derives an income code only when needed", async () => {
    const { fetchMock, requests } = makeFetch("pp50")
    vi.stubGlobal("fetch", fetchMock)
    const request: PP50PaymentRequest = {
      amount: "500",
      destinationAccount: "840000000000001",
      payeeAccount: "724000000000",
      sourceAccount: SOURCE_ACCOUNT,
      type: "pp50",
      urgency: false,
      valueDate: "02.09.2026",
    }

    const prepared = await preparePayment(request, {
      openSession: openSession(),
      today: TODAY,
    })

    expect(prepared.payload.IncomeCodeAndProgram).toBe("724123")
    expect(requests.map(({ path }) => path)).toEqual([
      "/DpsTransferFunds/PP50Order",
      "/Csp/RecipientDataAjax",
      "/Csp/ValidatePP50Account",
    ])
  })

  test("PP53 resolves the folio with one JSON request", async () => {
    const { fetchMock, requests } = makeFetch("pp53")
    vi.stubGlobal("fetch", fetchMock)
    const request: PP53PaymentRequest = {
      folioNumber: "folio-123",
      sourceAccount: SOURCE_ACCOUNT,
      type: "pp53",
      urgency: false,
      valueDate: "02.09.2026",
    }

    const result = await executePayment(request, "create", {
      openSession: openSession(),
      today: TODAY,
    })

    expect(result.status).toBe("draft-created")
    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /DpsTransferFunds/PP53Order",
      "POST /Csp/GetPiomResponse",
      "POST /DpsTransferFunds/PP53Order",
    ])
    const submitted = new URLSearchParams(requests[2].body)
    expect(submitted.get("Amount")).toBe("1250.50")
    expect(submitted.get("NumberOfOrders")).toBe("3")
  })
})

describe("payment submission safety", () => {
  test("cancellation performs no sign POST", async () => {
    const { fetchMock, requests } = makeFetch("pp30")
    vi.stubGlobal("fetch", fetchMock)

    const result = await executePayment(pp30Request(), "send", {
      confirm: async () => false,
      openSession: openSession(),
      today: TODAY,
    })

    expect(result.status).toBe("cancelled")
    expect(requests.map(({ path }) => path)).toEqual([
      "/DpsTransferFunds/Order",
      "/Csp/RecipientDataAjax",
    ])
  })

  test("interactive confirmation refuses a non-TTY process", async () => {
    const summary: PaymentSummary = {
      amount: "1.00",
      source: SOURCE_ACCOUNT,
      type: "pp30",
      urgency: false,
      valueDate: "02.09.2026",
    }
    const stdinTty = process.stdin.isTTY
    const stdoutTty = process.stdout.isTTY
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: false,
    })
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    })
    try {
      await expect(confirmPaymentInteractively(summary)).rejects.toThrow(
        "interactive terminal"
      )
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        configurable: true,
        value: stdinTty,
      })
      Object.defineProperty(process.stdout, "isTTY", {
        configurable: true,
        value: stdoutTty,
      })
    }
  })

  test("an ambiguous sign failure is not retried", async () => {
    const { fetchMock, requests } = makeFetch("pp30")
    fetchMock.mockImplementationOnce(fetchMock.getMockImplementation())
    fetchMock.mockImplementationOnce(fetchMock.getMockImplementation())
    fetchMock.mockRejectedValueOnce(new Error("connection reset"))
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      executePayment(pp30Request(), "send", {
        confirm: async () => true,
        openSession: openSession(),
        today: TODAY,
      })
    ).rejects.toBeInstanceOf(AmbiguousPaymentError)
    expect(requests).toHaveLength(2)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  test("polls JSON authorization status without another HTML GET", async () => {
    const orderResponse = `
      <div id="StateStatusMessage">Waiting for mKlik</div>
      <script>iBank.Forms.GetLongRunningTaskStatus('task-1', 'EntryForm', '12')</script>
    `
    const { fetchMock, requests } = makeFetch("pp30", orderResponse)
    vi.stubGlobal("fetch", fetchMock)

    const result = await executePayment(pp30Request(), "send", {
      confirm: async () => true,
      openSession: openSession(),
      poll: { intervalMs: 0, sleep: async () => undefined, timeoutMs: 100 },
      today: TODAY,
    })

    expect(result.status).toBe("approved")
    expect(requests.filter(({ method }) => method === "GET")).toHaveLength(1)
    expect(requests.map(({ path }) => path)).toEqual([
      "/DpsTransferFunds/Order",
      "/Csp/RecipientDataAjax",
      "/DpsTransferFunds/Order",
      "/DpsTransferFunds/GetLongRunningTaskStatus",
    ])
  })
})
