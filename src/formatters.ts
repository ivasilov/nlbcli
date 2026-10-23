export function formatTab(rows: string[][], headers?: string[]): string {
  return [...(headers ? [headers] : []), ...rows]
    .map((row) => row.join("\t"))
    .join("\n")
}

export function formatCsv(rows: string[][], headers: string[]): string {
  const escapeString = (s: string) => {
    if (
      s.includes(",") ||
      s.includes('"') ||
      s.includes("\n") ||
      s.includes("\r")
    ) {
      return `"${s.replace(/"/g, '""')}"`
    }
    return s
  }
  return [headers, ...rows]
    .map((row) => row.map(escapeString).join(","))
    .join("\n")
}

export function formatJson(rows: Record<string, string>[]): string {
  return JSON.stringify(rows, null, 2)
}

export function printTab(rows: string[][], headers?: string[]): void {
  console.log(formatTab(rows, headers))
}

export function printCsv(rows: string[][], headers: string[]): void {
  console.log(formatCsv(rows, headers))
}

export function printJson(rows: Record<string, string>[]): void {
  console.log(formatJson(rows))
}
