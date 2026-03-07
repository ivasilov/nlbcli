import { BASE_URL } from "./constants"

export interface HttpResponse {
  body: Buffer
  headers: Record<string, string | string[] | undefined>
  status: number
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
  return {
    status: res.status,
    headers: resHeaders,
    body: Buffer.from(await res.arrayBuffer()),
  }
}

export function isLoginRedirect(res: HttpResponse): boolean {
  return res.status === 302
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
