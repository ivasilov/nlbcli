# Bank response fixtures

Unless otherwise noted, these are minimized, redacted **representative fixtures
reconstructed from the selectors/request fields in this repository**, not captures
from a live banking session. Names, identifiers, amounts, descriptions, links, and report contents are
synthetic. No production cookies, tokens, credentials, or customer data are included.

`balances.html`, the balance fragments, and `reservations.html` pin the existing
page selectors. Transaction fragments pin supported header/sort-key mappings,
including reordered card columns, optional fields, and explicit empty tables.
The card layout is a supported parser contract, not a claim that every deployed
bank layout has been verified. Unrecognized tables fail rather than guessing
which column contains money. Add a sanitized capture when a new layout appears.

`no-data-transactions.html` is a minimized, redacted live response. It preserves
the bank's `.alert.alert-info.no-data` notice and absence of a transaction table
when a query has no matches. The account header and all customer data are removed.

`accounts/live-transactions.html` preserves the headings, currency suffixes, and
zero-based pager links from a live account response. All transaction values are
synthetic; customer details, identifiers, and links have been removed.

`login.html` and `error.html` exercise HTTP 200 failures as well as spoofed report
headers. `malformed-transactions.html` exercises a truncated row. Tests also
mutate fixtures to exercise invalid values and missing columns.

`report.xls` is a tiny SpreadsheetML report and `report.pdf` a minimal generated
PDF; `report-headers.json` supplies synthetic download headers. Tests use these
bodies byte-for-byte through the HTTP boundary and verify saved files.

Before adding real captures, remove identities, account/card numbers, cookies,
hidden input values, tokens, transaction references, and URL query strings. Keep
the DOM structure and locale punctuation needed to reproduce the parser issue.

The `accounts/` and `cards/` fragments also cover pagination; `session.json`
contains a synthetic named-profile session. `cards/report.xls` is the shared
SpreadsheetML report used by the atomic export and card tests.

`accounts/report.xls` is a fixed binary BIFF8 workbook containing the synthetic
rows in `transaction-fixtures.ts`, including Unicode, quotes, and a multiline
description. Keeping it as a fixture avoids needing a spreadsheet writer in tests.
