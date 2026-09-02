import { describe, expect, test } from "vitest"
import { dateFmt } from "../src/constants"

describe("dateFmt", () => {
  test.each([
    ["a regular date", new Date(2026, 8, 2), "02.09.2026"],
    ["single-digit days and months", new Date(2026, 0, 5), "05.01.2026"],
    ["a leap day", new Date(2024, 1, 29), "29.02.2024"],
    ["the end of a year", new Date(2026, 11, 31), "31.12.2026"],
    ["the start of a year", new Date(2027, 0, 1), "01.01.2027"],
  ])("formats %s as dd.mm.yyyy", (_description, date, expected) => {
    expect(dateFmt(date)).toBe(expected)
  })

  test("does not mutate the input date", () => {
    const date = new Date(2026, 8, 2, 12, 30, 45)
    const timestamp = date.getTime()

    dateFmt(date)

    expect(date.getTime()).toBe(timestamp)
  })

  test("rejects an invalid date", () => {
    expect(() => dateFmt(new Date(Number.NaN))).toThrow(RangeError)
  })
})
