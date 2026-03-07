export function printTab(rows: string[][], headers?: string[]): void {
  if (headers) {
    console.log(headers.join("\t"))
  }
  for (const row of rows) {
    console.log(row.join("\t"))
  }
}

export function printCsv(rows: string[][], headers: string[]): void {
  const escapeString = (s: string) => {
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`
    }
    return s
  }
  console.log(headers.map(escapeString).join(","))
  for (const row of rows) {
    console.log(row.map(escapeString).join(","))
  }
}

export function printJson(rows: Record<string, string>[]): void {
  console.log(JSON.stringify(rows, null, 2))
}
