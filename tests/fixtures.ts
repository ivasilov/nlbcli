import { readFileSync } from "node:fs"
import { vi } from "vitest"
import type { HttpResponse } from "../src/http"

export function fixture(name: string): Buffer {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url))
}

export function page(name: string): HttpResponse {
  return {
    status: 200,
    setCookies: [],
    headers: { "content-type": "text/html" },
    body: fixture(name),
  }
}

export function mockResponse(
  name: string,
  status = 200,
  headers = { "content-type": "text/html" }
): ReturnType<typeof vi.fn> {
  const fetchMock = vi
    .fn()
    .mockImplementation(() =>
      Promise.resolve(new Response(fixture(name), { status, headers }))
    )
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}
