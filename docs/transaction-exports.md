# Transaction export contract (v1)

```sh
nlbcli accounts transactions ACCOUNT_ID --format json
nlbcli accounts transactions ACCOUNT_ID --format csv
nlbcli cards transactions CARD_ID --format json
nlbcli cards transactions CARD_ID --format csv
```

JSON is a UTF-8 array of objects, with no envelope or status messages on stdout.
An empty result is `[]`. Both kinds have all their defined keys, including when a
value is missing. Missing/blank values are `null`; an empty bank numeric/date
placeholder `-` is also `null`. Zero is a value, never a missing value. Text is
trimmed and HTML entities are decoded; descriptions and statuses remain bank
text and may be localized. Property names, date syntax, and monetary syntax do
not depend on the machine's locale or timezone.

The machine-readable JSON Schemas are shipped in the npm package:

- [Account transactions](../schemas/account-transactions-v1.schema.json)
- [Card transactions](../schemas/card-transactions-v1.schema.json)

| Account field (in output order) | Value |
| --- | --- |
| `date` | Calendar date `YYYY-MM-DD`, or `null` |
| `recipient` | Counterparty text, or `null` |
| `description` | Description text, or `null` |
| `status` | Bank status text, or `null` |
| `amount` | Signed decimal string, or `null` |
| `fee` | Decimal string, or `null` |
| `balance` | Decimal string, or `null` |

| Card field (in output order) | Value |
| --- | --- |
| `date` | Calendar date `YYYY-MM-DD`, or `null` |
| `description` | Description/merchant text, or `null` |
| `amount` | Signed decimal string, or `null` |
| `currency` | Uppercase three-letter currency code, or `null` |

Monetary values **always remain strings**. The parser removes NLB's thousands
dots and replaces its decimal comma with a dot, using string operations only.
It also accepts decimal-point amounts, including comma grouping such as
`1,234.56`. Dot-separated groups of three digits with a one-to-three-digit
leading group follow the bank's grouping convention; other single-dot values
are decimal amounts.
For example, `9.007.199.254.740.993,01` becomes `"9007199254740993.01"` without
rounding. It preserves fractional digits (`42,5000` → `"42.5000"`), removes a
leading plus and redundant integer zeros, and normalizes Unicode minus and
negative zero. An ungrouped integer stays an integer string. A bank input of
`1.234` means one thousand two hundred thirty-four, never a decimal fraction.
Malformed punctuation, currency suffixes, and exponential notation fail
validation. Amount signs are preserved; no direction or currency is inferred.

Bank dates accept `d.m.yyyy` (with optional final dot) and `YYYY-MM-DD`.
Calendar validation includes leap years. Invalid dates/amounts fail the whole
response rather than silently dropping or partially exporting a row.

Example account JSON:

```json
[
  {
    "date": "2024-02-29",
    "recipient": "REDACTED & CO",
    "description": "Invoice, \"test\"",
    "status": "Booked",
    "amount": "-1234.50",
    "fee": "0.00",
    "balance": "9007199254740993.01"
  }
]
```

CSV uses the same normalized values, with an empty cell for `null`. It always
includes a header, including for empty results. The exact header lines are:

```csv
date,recipient,description,status,amount,fee,balance
```

```csv
date,description,amount,currency
```

Column order is fixed regardless of bank table order or missing optional
columns. Cells containing comma, quote, CR, or LF are quoted and embedded quotes
are doubled. Rows are separated by LF. JSON objects are emitted in the same
field order for readability, though consumers should access properties by name.

Recognized table headers/sort keys map bank columns to the contract. Missing
optional columns produce nulls; date and amount columns must be recognizable.
Legacy account fragments with absent or unrecognized headings use the existing
Details-plus-seven column layout. Unsupported layouts and truncated rows are errors. HTTP errors,
redirects, login forms, and recognized error pages are never empty success
responses. Errors/session progress go to stderr and CLI failures exit nonzero.

JSON/CSV exports for both accounts and cards use this contract.
Tab output retains bank display values. XLS/PDF account downloads and XLS card
downloads remain bank reports and do not follow this schema. Both transaction
commands support pagination and `--output <path>`; JSON/CSV
files use the same contract as stdout, and atomic replacement protects an
existing destination if validation or a later page fails.

Field names/order, null behavior, and value types form the v1 compatibility
contract. Breaking changes require a new schema version and a documented
migration; the schema version is independent of the npm package version.
`package.json` is the sole package-version source, also imported by the CLI for
`--version` (including the bundled build).
