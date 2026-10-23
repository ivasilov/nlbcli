import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { load } from "cheerio"
import { CompoundFile } from "compound-binary-file-js"
import { readXls } from "xls-reader"
import { bankResponseError } from "./errors"
import type { HttpResponse } from "./http"

const contentLengthPattern = /^\d+$/
const xmlEndTag = /<\/([\w:.-]+)\s*>$/

export function validateExportResponse(res: HttpResponse): void {
  if (res.status !== 200 || res.headers["content-range"]) {
    throw bankResponseError(
      "NLB returned an unsuccessful or incomplete export response."
    )
  }

  // fetch decompresses bodies, so Content-Length is only comparable for identity encoding.
  const encoding = res.headers["content-encoding"]
  const length = res.headers["content-length"]
  if (
    length !== undefined &&
    (!encoding || encoding === "identity") &&
    (!contentLengthPattern.test(String(length)) ||
      Number(length) !== res.body.length)
  ) {
    throw bankResponseError("NLB returned an incomplete export response.")
  }
}

function biffSubstreamType(body: Buffer, offset: number, size: number): number {
  if (size < 4) {
    throw new Error("Invalid BIFF BOF record")
  }
  return body.readUInt16LE(offset + 2)
}

function validateBiff(body: Buffer): void {
  let offset = 0
  let depth = 0
  let completed = 0
  let worksheets = 0
  while (offset < body.length) {
    // Some producers pad the Workbook stream with zeroes after the final EOF.
    if (
      depth === 0 &&
      completed > 0 &&
      body.subarray(offset).every((b) => b === 0)
    ) {
      break
    }
    if (offset + 4 > body.length) {
      throw new Error("Incomplete BIFF record")
    }
    const record = body.readUInt16LE(offset)
    const size = body.readUInt16LE(offset + 2)
    offset += 4 + size
    if (offset > body.length) {
      throw new Error("Incomplete BIFF record")
    }
    if ([0x00_09, 0x02_09, 0x04_09, 0x08_09].includes(record)) {
      worksheets += Number(
        biffSubstreamType(body, offset - size, size) === 0x00_10
      )
      depth += 1
    } else if (record === 0x00_0a && size === 0 && depth > 0) {
      depth -= 1
      completed += 1
    } else if (depth === 0) {
      throw new Error("Missing BIFF BOF record")
    }
  }
  if (depth !== 0 || completed === 0 || worksheets === 0) {
    throw new Error("Missing BIFF EOF record")
  }
}

function readWorkbookStream(body: Buffer): Buffer {
  const file = CompoundFile.fromUint8Array(body)
  const workbook = file
    .getRootStorage()
    .streams()
    .find((stream) =>
      ["Workbook", "Book"].includes(stream.getDirectoryEntryName())
    )
  if (!workbook) {
    throw new Error("Missing XLS workbook")
  }
  const size = workbook.getStreamSize()
  if (!Number.isSafeInteger(size) || size <= 0 || size > body.length) {
    throw new Error("Invalid XLS workbook size")
  }
  const contents = Buffer.from(workbook.getStreamData())
  if (contents.length !== size) {
    throw new Error("Incomplete XLS workbook")
  }
  return contents
}

function validateSpreadsheetXml(body: Buffer): void {
  const source = body.toString("utf-8").trim()
  const $ = load(source, {
    xml: { withStartIndices: true, withEndIndices: true },
  })
  const roots = $.root().children()
  const root = roots.get(0)
  const [prefix] = root?.name.split(":") ?? []
  const namespace = root?.name.includes(":") ? `xmlns:${prefix}` : "xmlns"
  if (
    roots.length !== 1 ||
    root?.name.split(":").at(-1) !== "Workbook" ||
    roots.attr(namespace) !== "urn:schemas-microsoft-com:office:spreadsheet"
  ) {
    throw new Error("Not a SpreadsheetML workbook")
  }
  if (
    !roots
      .children()
      .toArray()
      .some((element) => element.name.split(":").at(-1) === "Worksheet")
  ) {
    throw new Error("Missing XLS worksheets")
  }
  for (const element of $("*").toArray()) {
    if (element.type !== "tag") {
      continue
    }
    if (element.startIndex == null || element.endIndex == null) {
      throw new Error("Incomplete SpreadsheetML element")
    }
    const text = source.slice(element.startIndex, element.endIndex + 1)
    if (text.endsWith("/>") && element.children.length === 0) {
      continue
    }
    if (text.match(xmlEndTag)?.[1] !== element.name) {
      throw new Error("Incomplete SpreadsheetML element")
    }
  }
}

export function validateXls(body: Buffer): void {
  const error =
    "NLB did not return a valid XLS file. Try --format tab, csv, or json."
  try {
    if (body.subarray(0, 8).equals(Buffer.from("d0cf11e0a1b11ae1", "hex"))) {
      if (body.length < 512) {
        throw new Error("Incomplete XLS container")
      }
      const sectorShift = body.readUInt16LE(30)
      if (
        ![9, 12].includes(sectorShift) ||
        body.length % 2 ** sectorShift !== 0
      ) {
        throw new Error("Incomplete XLS container")
      }
      const stream = readWorkbookStream(body)
      validateBiff(stream)
      // Keep explicit record/EOF checks: cell readers may tolerate truncated BIFF.
      if (
        stream.readUInt16LE(4) === 0x06_00 &&
        readXls(body).sheets.length === 0
      ) {
        throw new Error("Missing XLS worksheets")
      }
    } else if (body.toString("utf-8").trimStart().startsWith("<")) {
      // Excel also supports XML Spreadsheet 2003 reports with an .xls extension.
      validateSpreadsheetXml(body)
    } else {
      // Older XLS reports can contain a bare BIFF stream rather than a CFB container.
      validateBiff(body)
    }
  } catch {
    throw bankResponseError(error)
  }
}

export function validatePdf(body: Buffer): void {
  if (
    body.subarray(0, 5).toString("ascii") !== "%PDF-" ||
    !body.subarray(-1024).toString("ascii").trimEnd().endsWith("%%EOF")
  ) {
    throw bankResponseError(
      "NLB did not return a valid PDF file. Try --format tab, csv, or json."
    )
  }
}

export function writeExport(
  destination: string,
  body: Buffer,
  validate: (contents: Buffer) => void
): { kind: "file"; path: string; bytes: number } {
  const temporary = path.join(
    path.dirname(destination),
    `.nlbcli-${randomUUID()}.tmp`
  )
  let created = false
  try {
    const fd = fs.openSync(temporary, "wx", 0o600)
    created = true
    try {
      fs.writeFileSync(fd, body)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    const completed = fs.readFileSync(temporary)
    if (!completed.equals(body)) {
      throw new Error("Incomplete export file")
    }
    validate(completed)
    fs.renameSync(temporary, destination)
    return { kind: "file", path: destination, bytes: completed.length }
  } finally {
    if (created) {
      fs.rmSync(temporary, { force: true })
    }
  }
}
