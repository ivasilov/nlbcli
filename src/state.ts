import fs from "node:fs"
import { COOKIES_FILE, STATE_DIR } from "./constants"

export function saveCookies(cookieHeader: string, username: string): void {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true })
  }
  fs.writeFileSync(
    COOKIES_FILE,
    JSON.stringify({ cookie: cookieHeader, username })
  )
}

export function loadState(): { cookie: string; username: string } | null {
  if (!fs.existsSync(COOKIES_FILE)) {
    return null
  }
  try {
    const data = JSON.parse(fs.readFileSync(COOKIES_FILE, "utf-8"))
    return data.cookie
      ? { cookie: data.cookie, username: data.username || "" }
      : null
  } catch {
    return null
  }
}
