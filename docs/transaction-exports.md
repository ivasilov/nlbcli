# Transaction export contract (v1)

## Scope

This contract defines JSON and CSV exports for account and card transactions,
including stdout and files saved with `--output`. For commands, filters, and
format selection, see [Output and exports](../README.md#output-and-exports).

Tab output retains bank display values. Account XLS/PDF reports and card XLS
reports use the bank's report format and fall outside this contract.

## Account and card schemas

The machine-readable JSON Schemas are shipped in the npm package. Every JSON
object includes all fields for its transaction kind, including fields whose
value is `null`. The tables below list fields in output order.

### Account transactions

[Account JSON Schema](../schemas/account-transactions-v1.schema.json)

| Field | Value |
| --- | --- |
| `date` | Calendar date `YYYY-MM-DD`, or `null` |
| `recipient` | Counterparty text, or `null` |
| `description` | Description text, or `null` |
| `status` | Bank status text, or `null` |
| `amount` | Signed decimal string, or `null` |
| `fee` | Decimal string, or `null` |
| `balance` | Decimal string, or `null` |

Exact CSV header:

```csv
date,recipient,description,status,amount,fee,balance
```

Example JSON:

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

### Card transactions

[Card JSON Schema](../schemas/card-transactions-v1.schema.json)

| Field | Value |
| --- | --- |
| `date` | Calendar date `YYYY-MM-DD`, or `null` |
| `description` | Description/merchant text, or `null` |
| `amount` | Signed decimal string, or `null` |
| `currency` | Uppercase three-letter currency code, or `null` |

Exact CSV header:

```csv
date,description,amount,currency
```

Example JSON:

```json
[
  {
    "date": "2024-02-29",
    "description": "REDACTED MERCHANT",
    "amount": "-42.50",
    "currency": "MKD"
  }
]
```

## Value normalization

Property names, date syntax, and monetary syntax are independent of the machine's
locale and timezone. JSON and CSV use the same normalized values.

### Missing values and text

Missing or blank values become `null` in JSON and empty cells in CSV. The bank's
`-` placeholder for an empty numeric or date value also becomes `null`. Zero
remains a value.

Text is trimmed and HTML entities are decoded. Descriptions and statuses retain
the bank's text and may be localized.

### Dates

Bank dates accept `d.m.yyyy` (with an optional final dot) and `YYYY-MM-DD`.
Exported dates use `YYYY-MM-DD`. Calendar validation includes leap years.

### Monetary values

Monetary values remain **exact decimal strings**. Normalization uses string
operations to preserve precision and fractional digits.

The parser removes NLB's thousands dots and replaces its decimal comma with a
dot. It also accepts decimal-point amounts, including comma grouping such as
`1,234.56`. Dot-separated groups of three digits with a one-to-three-digit
leading group follow the bank's grouping convention; other single-dot values
are decimal amounts.

| Bank value | Exported string | Meaning |
| --- | --- | --- |
| `9.007.199.254.740.993,01` | `"9007199254740993.01"` | Precision preserved without rounding |
| `42,5000` | `"42.5000"` | Fractional digits preserved |
| `1,234.56` | `"1234.56"` | Comma grouping with a decimal point |
| `1.234` | `"1234"` | Bank thousands grouping |

Normalization removes a leading plus and redundant integer zeros, and normalizes
Unicode minus and negative zero. An ungrouped integer stays an integer string.
Amount signs are preserved; neither direction nor currency is inferred.
Bank table amounts may include a whitespace-separated, uppercase three-letter
currency suffix (for example, `1.234,56 MKD`). JSON and CSV omit that suffix;
tab output retains it. Malformed punctuation, malformed currency suffixes, and
exponential notation fail validation.

For card tables without a separate currency column, `currency` comes from the
original amount's suffix. The card `date` is the transaction date, and `amount`
is the original transaction amount; the booking date, domestic amount, and
local-currency balance are not included in JSON/CSV.
NLB applies card date-range filters to the booking date, so a matching purchase
can have a transaction `date` outside the requested range.

## JSON and CSV encoding

JSON is a UTF-8 array of objects with no envelope. Empty results are `[]`.
Objects are emitted in the field order above for readability; consumers should
access properties by name.

CSV always includes the exact header for its transaction kind, including for
empty results. Column order is fixed regardless of bank table order or missing
optional columns. Cells containing comma, quote, CR, or LF are quoted, and
embedded quotes are doubled. Rows are separated by LF.

## Validation and delivery

Invalid dates or amounts fail the whole export. Unsupported layouts and
truncated rows also fail; rows are never silently dropped or partially exported.
HTTP errors, redirects, login forms, and recognized error pages are errors,
including when they contain no transaction rows.
Account responses that identify a different account also fail rather than
exporting another account's history. Savings accounts use a separate bank
endpoint and are not currently supported by the account transaction command.

Both transaction commands collect all pages for JSON/CSV exports. Stdout contains
only data; errors and session progress go to stderr, and failures exit nonzero.
Files saved with `--output` use the same contract as stdout. Atomic replacement
protects an existing destination if validation or a later page fails.

### Bank table recognition

For parser maintainers: recognized table headers or sort keys map bank columns
to the contract. Missing optional columns produce nulls; date and amount columns
must be recognizable. Legacy account fragments with absent or unrecognized
headings use the existing Details-plus-seven column layout.

## Compatibility

Field names and order, null behavior, and value types form the v1 compatibility
contract. Breaking changes require a new schema version and a documented
migration. The schema version is independent of the npm package version.
