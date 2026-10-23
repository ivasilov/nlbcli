import { BASE_URL } from "./constants"
import {
  authenticationError,
  bankResponseError,
  CliError,
  EXIT_CODES,
} from "./errors"

const loginForm =
  /<(?:form|input)\b[^>]*(?:Account\/Login|LoginUserNamePush|UserName|Password)/i
const loginJson =
  /["'](?:RedirectionUrl|RedirectUrl)["']\s*:\s*["'][^"']*\/Account\/Login/i
const loginLocation = /\/Account\/Login/i
const htmlTag = /<[a-z][\s\S]*>/i
export const TABLE_HTML = /<table\b/i
// A balance page may have no accounts/cards. Accept its page marker or an
// authenticated navigation link as well as the IDs that the list commands use.
const balancesPage =
  /[0-9]{3}-[0-9]{10}-[0-9]{2}[A-Z]{2,3}|[0-9]{8,15}\/[0-9]{4}|\b(?:id|class)\s*=\s*["'][^"']*balance|\/Account\/(?:LogOff|LogOut)/i
const cookieSeparator = /;\s*/

export interface HttpResponse {
  body: Buffer
  headers: Record<string, string | string[] | undefined>
  setCookies: string[]
  status: number
}

export function mergeCookieHeader(
  existing: string,
  newSetCookies: readonly string[]
): string {
  const jar = new Map<string, string>()

  for (const pair of existing.split(cookieSeparator)) {
    const separator = pair.indexOf("=")
    if (separator > 0) {
      jar.set(pair.slice(0, separator).trim(), pair.slice(separator + 1))
    }
  }

  for (const setCookie of newSetCookies) {
    const pair = setCookie.split(";", 1)[0]
    const separator = pair.indexOf("=")
    if (separator > 0) {
      jar.set(pair.slice(0, separator).trim(), pair.slice(separator + 1))
    }
  }

  return [...jar.entries()]
    .map(([name, value]) => `${name}=${value}`)
    .join("; ")
}

export async function bankFetch(
  url: string | URL,
  init: RequestInit = {}
): Promise<Response> {
  let response: Response
  try {
    response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new CliError(
      EXIT_CODES.network,
      "Unable to reach NLB. Check your connection and try again."
    )
  }
  if (response.status === 401 || response.status === 403) {
    throw authenticationError()
  }
  if (response.status >= 400) {
    throw bankResponseError(
      `NLB returned an invalid response (HTTP ${response.status}).`
    )
  }
  return response
}

export async function readBankJson(
  response: Response
): Promise<Record<string, unknown>> {
  let data: unknown
  try {
    data = await response.json()
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw bankResponseError("NLB returned invalid JSON during login.")
    }
    throw new CliError(
      EXIT_CODES.network,
      "Unable to read the response from NLB. Try again."
    )
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw bankResponseError("NLB returned an invalid login response.")
  }
  return data as Record<string, unknown>
}

function validateStatus(res: Pick<HttpResponse, "status" | "headers">): void {
  if (isLoginRedirect(res) || res.status === 401 || res.status === 403) {
    throw authenticationError()
  }
  if (res.status < 200 || res.status >= 300) {
    throw bankResponseError(
      `NLB returned an invalid response (HTTP ${res.status}).`
    )
  }
}

function validateResponse(res: HttpResponse): void {
  if (isAuthenticationResponse(res)) {
    throw authenticationError()
  }
}

export function isAuthenticationResponse(res: HttpResponse): boolean {
  if (isLoginRedirect(res) || res.status === 401 || res.status === 403) {
    return true
  }
  const html = res.body.toString("utf-8")
  return loginForm.test(html) || loginJson.test(html)
}

export function requireHtml(res: HttpResponse, selector?: RegExp): string {
  const html = res.body.toString("utf-8")
  if (!htmlTag.test(html) || (selector && !selector.test(html))) {
    throw bankResponseError(
      "NLB returned an unrecognized page. Try again or log in again."
    )
  }
  return html
}

export function requireBalancesPage(res: HttpResponse): string {
  return requireHtml(res, balancesPage)
}

async function httpRequest(
  method: string,
  urlPath: string,
  cookieHeader: string,
  body?: string
): Promise<HttpResponse> {
  const url = new URL(urlPath, BASE_URL)
  const headers: Record<string, string> = {
    Cookie: cookieHeader,
    "X-Requested-With": "XMLHttpRequest",
  }
  if (body) {
    headers["Content-Type"] = "application/x-www-form-urlencoded"
  }
  const res = await bankFetch(url, {
    method,
    headers,
    body,
    redirect: "manual",
  })
  const resHeaders: Record<string, string | string[] | undefined> = {}
  res.headers.forEach((value, key) => {
    resHeaders[key] = value
  })
  const setCookies = res.headers.getSetCookie?.() ?? []
  // Redirects already identify expired sessions; do not wait for their bodies.
  validateStatus({ status: res.status, headers: resHeaders })
  let bodyBuffer: Buffer
  try {
    bodyBuffer = Buffer.from(await res.arrayBuffer())
  } catch {
    throw new CliError(
      EXIT_CODES.network,
      "Unable to read the response from NLB. Try again."
    )
  }
  const response = {
    status: res.status,
    headers: resHeaders,
    setCookies,
    body: bodyBuffer,
  }
  validateResponse(response)
  return response
}

export class NlbHttpClient {
  cookieHeader: string

  constructor(cookieHeader: string) {
    this.cookieHeader = cookieHeader
  }

  private async request(
    method: "GET" | "POST",
    urlPath: string,
    body?: string
  ): Promise<HttpResponse> {
    const headers: Record<string, string> = {
      Cookie: this.cookieHeader,
      "X-Requested-With": "XMLHttpRequest",
    }
    if (method === "POST") {
      headers["Content-Type"] = "application/x-www-form-urlencoded"
    }

    const response = await bankFetch(new URL(urlPath, BASE_URL), {
      method,
      headers,
      body,
      redirect: "manual",
    })
    const responseHeaders: Record<string, string | string[] | undefined> = {}
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value
    })
    const setCookies = response.headers.getSetCookie?.() ?? []
    this.cookieHeader = mergeCookieHeader(this.cookieHeader, setCookies)

    let responseBody: Buffer
    try {
      responseBody = Buffer.from(await response.arrayBuffer())
    } catch {
      throw new CliError(
        EXIT_CODES.network,
        "Unable to read the response from NLB. Try again."
      )
    }

    return {
      body: responseBody,
      headers: responseHeaders,
      setCookies,
      status: response.status,
    }
  }

  get(urlPath: string): Promise<HttpResponse> {
    return this.request("GET", urlPath)
  }

  post(urlPath: string, data: Record<string, string>): Promise<HttpResponse> {
    return this.request("POST", urlPath, new URLSearchParams(data).toString())
  }
}

export function isLoginRedirect(
  res: Pick<HttpResponse, "status" | "headers">
): boolean {
  return (
    res.status === 302 ||
    (res.status >= 300 &&
      res.status < 400 &&
      loginLocation.test(String(res.headers.location)))
  )
}

export function nlbGet(urlPath: string, cookie: string): Promise<HttpResponse> {
  return httpRequest("GET", urlPath, cookie)
}

export function nlbPost(
  urlPath: string,
  cookie: string,
  data: Record<string, string>
): Promise<HttpResponse> {
  return httpRequest(
    "POST",
    urlPath,
    cookie,
    new URLSearchParams(data).toString()
  )
}
