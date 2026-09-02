import { BASE_URL } from "./constants"

const COOKIE_SEPARATOR_PATTERN = /;\s*/

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

  for (const pair of existing.split(COOKIE_SEPARATOR_PATTERN)) {
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
    const url = new URL(urlPath, BASE_URL)
    const headers: Record<string, string> = {
      Cookie: this.cookieHeader,
      "X-Requested-With": "XMLHttpRequest",
    }
    if (method === "POST") {
      headers["Content-Type"] = "application/x-www-form-urlencoded"
    }
    const res = await fetch(url, {
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
    this.cookieHeader = mergeCookieHeader(this.cookieHeader, setCookies)

    return {
      status: res.status,
      headers: resHeaders,
      setCookies,
      body: Buffer.from(await res.arrayBuffer()),
    }
  }

  get(urlPath: string): Promise<HttpResponse> {
    return this.request("GET", urlPath)
  }

  post(urlPath: string, data: Record<string, string>): Promise<HttpResponse> {
    return this.request("POST", urlPath, new URLSearchParams(data).toString())
  }
}

export function isLoginRedirect(res: HttpResponse): boolean {
  return res.status === 302
}

export function nlbGet(urlPath: string, cookie: string): Promise<HttpResponse> {
  return new NlbHttpClient(cookie).get(urlPath)
}

export function nlbPost(
  urlPath: string,
  cookie: string,
  data: Record<string, string>
): Promise<HttpResponse> {
  return new NlbHttpClient(cookie).post(urlPath, data)
}
