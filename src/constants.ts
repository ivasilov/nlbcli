import path from "node:path"

export const BASE_URL = "https://www.nlbklik.com.mk"
export const STATE_DIR = path.join(process.env.HOME || "~", ".nlbcli")
export const COOKIES_FILE = path.join(STATE_DIR, "cookies.json")

const dateFmtIntl = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
})

export const dateFmt = (date: Date): string => {
  const parts = Object.fromEntries(
    dateFmtIntl.formatToParts(date).map(({ type, value }) => [type, value])
  )
  return `${parts.day}.${parts.month}.${parts.year}`
}
