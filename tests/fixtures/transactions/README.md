These HTML fixtures contain synthetic redacted data, not customer captures.
They model the transaction table parsed by the CLI and the bank's public
`iBank.Forms.SetFormFieldValueAndSubmitForm` pager API (`PageNumber`, `.pagination`,
and active/disabled controls). Names, account IDs, transaction IDs, and amounts
are placeholders. Dates intentionally match across rows to test bank ordering.

- `one-page.html`: three transactions, including CSV quoting characters.
- `page-1.html`, `page-2.html`, `page-3.html`: 202 transactions across three pages.
- `empty.html`: an explicit empty-result table.
- `repeated-page.html`: page two advertises progress but repeats page one's rows.
- `failed-page.html`: a synthetic server error used with HTTP 503 and HTTP 200.

Tests also remove or alter pagination fields to exercise missing controls,
wrong page numbers, partial pages, overlaps, and failures without live banking
requests.
