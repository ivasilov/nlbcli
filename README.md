# nlbcli

**Unofficial** CLI for [NLB Klik](https://www.nlbklik.com.mk) (НЛБ Банка АД Скопје). Check account and card balances, export transactions, and create or send payment orders from the terminal.

This TypeScript implementation builds on the original [Python nlbcli](https://github.com/whoeverest/nlbcli) and supports notification-based login.

> [!CAUTION]
> This tool is not developed or endorsed by НЛБ Банка АД Скопје. Use at your own risk.

## Get started

You need Node.js >= 18 and an NLB Klik account with push notification authentication enabled on your phone.

1. Install the CLI:

   ```sh
   npm install --global nlbcli
   ```

2. Log in and approve the push notification on your phone. The CLI waits up to 120 seconds:

   ```sh
   nlbcli login --username <USERNAME>
   ```

3. List your accounts, then use an ID from the result to check a balance:

   ```sh
   nlbcli accounts list
   nlbcli accounts balance <ACCOUNT_ID>
   ```

For shell completions, run `source <(nlbcli --completions zsh)`. Replace `zsh` with `bash`, `sh`, or `fish` to generate completions for that shell.

To install the agent skill:

```sh
npx skills add ivasilov/nlbcli
```

## Profiles and sessions

Use the root `--profile` option before the command to keep logins separate:

```sh
nlbcli --profile personal login --username <PERSONAL_USERNAME>
nlbcli --profile work login --username <WORK_USERNAME>
nlbcli --profile personal accounts transactions <ACCOUNT_ID> --format json
nlbcli --profile work cards transactions <CARD_ID>
```

Every login, account, card, and payment command uses the selected profile. Omitting `--profile` selects `default`; commands never fall back to another profile. Profile names must start with an ASCII letter or digit and contain only ASCII letters, digits, dots, underscores, or hyphens.

Each profile saves its username and session at `~/.nlbcli/profiles/<profile>/session.json`. Subsequent commands reuse the session. Interactive commands can re-authenticate an expired session using that profile's saved username.

Session cookies are stored in plaintext. Profile directories have permissions `0700` and session files have permissions `0600`. The legacy `~/.nlbcli/cookies.json` is no longer read; log in again for each profile after upgrading from shared-cookie storage.

## Accounts and cards

| Command | Purpose |
| --- | --- |
| `nlbcli accounts list` | List account IDs |
| `nlbcli accounts balance <ACCOUNT_ID>` | Show account balance |
| `nlbcli accounts transactions <ACCOUNT_ID>` | List account transactions |
| `nlbcli accounts reservations <ACCOUNT_ID>` | Show pending reservations |
| `nlbcli cards list` | List card IDs |
| `nlbcli cards balance <CARD_ID>` | Show card balance and details |
| `nlbcli cards transactions <CARD_ID>` | List card transactions |

Both transaction commands accept `--start` and `--end` in `dd.mm.yyyy` format. Omitted bounds default to 30 days ago and today. Dates must be valid, with the start on or before the end.

Account transactions also accept `--name` to filter by counterparty name and `--type in` or `--type out` to filter by direction:

```sh
nlbcli accounts transactions <ACCOUNT_ID> \
  --start 01.01.2026 \
  --end 31.01.2026 \
  --name EVN \
  --type out \
  --format json
```

### Output and exports

| Command | Supported formats | Default |
| --- | --- | --- |
| Account balance | `tab`, `csv`, `json` | `tab` |
| Account transactions | `tab`, `csv`, `json`, `xls`, `pdf` | `tab` |
| Card transactions | `tab`, `csv`, `json`, `xls` | `tab` |

Account/card lists, reservations, and card balances print text without a `--format` option. Transaction `tab` output retains bank display values. JSON and CSV exports normalize values and collect all pages. XLS and PDF exports download the bank's report for the requested range.

Without `--output`, text formats print to stdout and report files are saved under `./downloads/`. Use `--output <path>` with either transaction command to save any supported format to an exact file path. Its parent directory must already exist:

```sh
nlbcli accounts transactions <ACCOUNT_ID> --format xls --output ./transactions.xls
nlbcli cards transactions <CARD_ID> \
  --start 01.01.2026 \
  --end 31.01.2026 \
  --format csv \
  --output ./card-transactions.csv
```

Exports are validated in a temporary file beside the destination, then atomically replace it. Failed or incomplete exports leave an existing destination unchanged and remove temporary files. Save confirmations go to stderr.

When NLB returns an HTML wrapper for an XLS or PDF report, the CLI downloads the file from the wrapper's bank report URL and validates that file before saving it.

Before requesting an XLS report, the CLI checks the first transaction page using the same account/card, date range, and filters. If there are no matching transactions, it prints `No transactions found.`, exits successfully, and skips the report request. No file or downloads directory is created, and an existing output file is preserved. This avoids NLB's report error for empty periods.

Bank report availability can vary by account/card and date range. If report generation or download returns an HTTP 5xx error, the CLI reports the failed format and HTTP status, exits with code `5`, and suggests `--format tab`, `csv`, or `json`. The response alone cannot distinguish an unsupported report from a temporary bank failure. No report is saved, and an existing output file is preserved.

Account and card JSON/CSV transactions follow a stable contract: dates use `YYYY-MM-DD`, monetary values are exact decimal **strings**, and missing values are `null` in JSON or empty cells in CSV. Empty results are `[]` in JSON and headers only in CSV. Use decimal arithmetic when calculating monetary totals to preserve precision.

When building an importer, validating exports, or handling bank value normalization, read the [v1 transaction export contract](docs/transaction-exports.md). It defines account and card fields, exact CSV headers, JSON Schemas and examples, normalization rules, validation guarantees, and version compatibility.

## Scripts and agent data reads

Add `--non-interactive` to account or card commands to use only the selected profile's saved session:

```sh
nlbcli --profile work --non-interactive accounts balance <ACCOUNT_ID> --format json
nlbcli --profile work --non-interactive cards transactions <CARD_ID> --format json
```

The flag works before or after subcommands. Commands in this mode never prompt, request push approval, or require a TTY. A missing, unreadable, invalid, or expired session exits with code `3` and prints a login command to stderr, including the selected profile and its saved username when available. Run that login command interactively, then retry the data read.

Data goes to stdout. Progress, save confirmations, empty-result notices, and errors go to stderr. Valid empty results succeed. Network requests time out after 15 seconds; non-interactive commands never wait for push approval. `login`, `--wizard`, and `payments send` require interactive operation and cannot be combined with `--non-interactive`.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success, including valid empty results |
| `1` | Unexpected local/runtime error |
| `2` | Invalid arguments, formats, dates, or incompatible interactive options |
| `3` | Authentication required, missing/expired session, or failed login |
| `4` | Network failure, request timeout, or interrupted response |
| `5` | Invalid bank response, including unexpected HTTP status, malformed data, or invalid report file |

For payment outcomes, also inspect the reported `STATUS` as described below.

## Payments

> [!CAUTION]
> Payment commands are experimental. Review every payment and verify its final status in NLB Klik, especially after a timeout or unknown response.

`payments create` saves an unsigned payment order. `payments send` reviews, signs, and submits an order using the same options. Choose the operation you intend; running `send` after `create` starts another order rather than signing the saved draft.

To create an unsigned PP30 order:

```sh
nlbcli payments create pp30 \
  --source <ACCOUNT_ID> \
  --destination <RECIPIENT_ACCOUNT> \
  --amount 1250.00 \
  --purpose-code 289 \
  --purpose "Invoice 123"
```

To submit an order, use `payments send` in an interactive terminal. The CLI displays the resolved details and submits only after you type `SEND`. Complete the authorization in mKlik when prompted. There is no non-interactive confirmation flag.

### Order types and fields

All types require `--source` and accept `--date` and `--urgent`. Payment amounts are in MKD. `--date` uses `dd.mm.yyyy` and defaults to today; `--urgent` requests MIPS.

| Type | Additional required options | Optional options |
| --- | --- | --- |
| `pp30` | `--destination`, `--amount`, `--purpose-code` | `--purpose`, `--recipient-name`, `--recipient-address`, `--debit-reference`, `--credit-reference` |
| `pp50` | `--destination`, `--amount` | `--purpose`, `--recipient-name`, `--recipient-address`, `--debit-reference`, `--payee-account`, `--budgetary-account`, `--income-code-program` |
| `pp53` | `--folio` | — |

For external or unknown destination accounts, supply both `--recipient-name` and `--recipient-address`. For PP50, NLB can derive `--income-code-program` when `--payee-account` or `--budgetary-account` is supplied. For PP53, NLB resolves the total and number of orders from the folio number.

### Verify the outcome

Read the reported `STATUS`, order ID when present, and message. `draft-created` means an unsigned order was saved; `cancelled` means nothing was submitted. An `awaiting-authorization` or `submitted` result still requires checking the final status in NLB Klik.

> [!WARNING]
> If a create or send request ends with an unknown result or a network failure, do not retry it. First verify the order in NLB Klik to avoid creating a duplicate payment.

## Command help

Run `nlbcli --help` for the command tree or append `--help` to a command for its installed options, for example `nlbcli cards transactions --help` or `nlbcli payments send --help`.

Run `nlbcli --version` or `nlbcli -v` to print the installed version.

## How it works

Built with TypeScript and [Effect](https://effect.website/) for the CLI framework. Authentication uses NLB Klik's push notification flow. Subsequent interactions use `fetch` requests with the saved session cookie; [Cheerio](https://cheerio.js.org/) parses HTML responses.

## License

[MIT](LICENSE)
