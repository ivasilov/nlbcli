All fixtures are synthetic and redacted. Account/card identifiers, cookies,
usernames, merchants, amounts, and dates contain no production banking data.
`cards/report.xls` is a minimal SpreadsheetML report for testing downloads.
`accounts/report.xls` is a fixed binary BIFF8 workbook containing the synthetic
rows in `transaction-fixtures.ts`, including Unicode, quotes, and a multiline
description. Keeping it as a fixture avoids needing a spreadsheet writer in tests.
