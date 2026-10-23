# nlbcli


**Unofficial** CLI for [NLB Klik](https://www.nlbklik.com.mk) (НЛБ Банка АД Скопје). Check balances, list transactions, view card details, and more — straight from the terminal. 

This is a Typescript implementation of the [nlbcli](https://github.com/whoeverest/nlbcli) which was written in Python, updated to support notification-based login.

> [!CAUTION]
> This tool is not developed or endorsed by НЛБ Банка АД Скопје. Use at your own risk.

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18

## Install

```zsh
npm install nlbcli -g
```

You can add code completions by running:

```zsh
source <(nlbcli --completions zsh)
```

You can replace `zsh` with `bash` or `sh`  or `fish`.

If you want to also use this CLI with your AI agent, you can install the following skill:

```zsh
npx skills add ivasilov/nlbcli
``` 

## Authentication

```bash
nlbcli login --username <your-username>
```

This sends a push notification to your phone. Once approved, the session is saved to `~/.nlbcli/profiles/default/session.json` so subsequent commands work without re-authenticating. Expired sessions are detected automatically and trigger re-authentication using that profile's saved username.

Use the root `--profile` option before the command to keep different logins separate:

```bash
nlbcli --profile personal login --username <personal-username>
nlbcli --profile work login --username <work-username>
nlbcli --profile personal accounts transactions <ACCOUNT_ID> --format json
nlbcli --profile work cards transactions <CARD_ID>
```

Every login, account, and card command uses the selected profile. Omitting `--profile` selects `default`. Each profile stores its session and username at `~/.nlbcli/profiles/<profile>/session.json`. Profile names must start with an ASCII letter or digit and contain only ASCII letters, digits, dots, underscores, or hyphens.

Profile directories have permissions `0700` and session files have permissions `0600`. Session cookies are stored in plaintext. The old shared `~/.nlbcli/cookies.json` is no longer used; run `login` again for each profile after upgrading.

For scripts, use the global `--non-interactive` flag with any account or card data command:

```bash
nlbcli --profile work --non-interactive accounts balance <ACCOUNT_ID> --format json
nlbcli --profile work cards list --non-interactive
```

The flag works before or after subcommands and combines with `--profile <name>` (or `default` when omitted). These commands use only the saved session and never prompt, request push approval, or require a TTY. If the session is missing, unreadable, invalid, or expired, they exit with code `3` and print the login command to stderr. Run that command interactively, then retry. Only the selected profile is read, and the login instruction includes `--profile <name>` and its saved username when available. No other profile is used as a fallback. `login` and `--wizard` cannot be used with `--non-interactive`.

Data is written to stdout. Progress, download confirmations, empty-result notices, and errors are written to stderr. Empty JSON transaction results are `[]`. Network requests time out after 15 seconds; non-interactive commands never wait for the push approval timeout.

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success (including valid empty results) |
| `1` | Unexpected local/runtime error |
| `2` | Invalid arguments, including unsupported formats, invalid dates, or interactive options combined with `--non-interactive` |
| `3` | Authentication required, missing/expired session, or failed login |
| `4` | Network failure, request timeout, or interrupted response |
| `5` | Invalid bank response: unexpected HTTP status, unrecognized/malformed data, or invalid report file |

## Commands

### Accounts

| Command | Description |
|---------|-------------|
| `nlbcli accounts list` | List account IDs |
| `nlbcli accounts balance <ACCOUNT_ID>` | Show account balance |
| `nlbcli accounts transactions <ACCOUNT_ID>` | List recent transactions |
| `nlbcli accounts reservations <ACCOUNT_ID>` | Show pending reservations |

Transaction filters:

```bash
nlbcli accounts transactions <ACCOUNT_ID> \
  --start="01.01.2024" \
  --end="30.01.2024" \
  --name="EVN" \
  --type="out"
```

### Cards

| Command | Description |
|---------|-------------|
| `nlbcli cards list` | List card IDs |
| `nlbcli cards balance <CARD_ID>` | Show card balance and details |
| `nlbcli cards transactions <CARD_ID>` | List card transactions |

Card transactions accept the same date bounds and export options as account transactions:

```bash
nlbcli --profile work --non-interactive cards transactions <CARD_ID> \
  --start 01.01.2024 \
  --end 31.01.2024 \
  --format csv \
  --output ./card-transactions.csv
```

Dates must be valid `dd.mm.yyyy` values and the start must be on or before the end. Omitted bounds default to 30 days ago and today. CSV, JSON, and tab exports collect all pages; XLS requests the bank's report for the specified range.

### Payments

> [!CAUTION]
> Payment commands are experimental. Carefully review every payment and verify
> its final status in NLB Klik, especially after a timeout or unknown response.

Create a saved payment order without signing it:

```bash
nlbcli payments create pp30 \
  --source="210-0000000000-00MKD" \
  --destination="300-0000000000-00" \
  --amount="1250.00" \
  --purpose-code="289" \
  --purpose="Invoice 123"
```

Use `payments send` with the same options to review and sign an order. Sending
requires an interactive terminal: the CLI displays the resolved payment details
and submits only after you type `SEND`. Complete the authorization in mKlik when
prompted. There is intentionally no non-interactive confirmation flag.

Supported order types and additional options:

| Type | Required options | Optional options |
|------|------------------|------------------|
| `pp30` | `--source`, `--destination`, `--amount`, `--purpose-code` | `--purpose`, `--recipient-name`, `--recipient-address`, `--debit-reference`, `--credit-reference`, `--date`, `--urgent` |
| `pp50` | `--source`, `--destination`, `--amount` | `--purpose`, `--recipient-name`, `--recipient-address`, `--debit-reference`, `--payee-account`, `--budgetary-account`, `--income-code-program`, `--date`, `--urgent` |
| `pp53` | `--source`, `--folio` | `--date`, `--urgent` |

PP53 totals are resolved from NLB using the folio number. For PP50, NLB can
derive `--income-code-program` when `--payee-account` or `--budgetary-account`
is supplied. For external or unknown destination accounts, pass both
`--recipient-name` and `--recipient-address`.

> [!WARNING]
> If a create or send request ends with an unknown result or a network failure,
> do not retry it. First verify the order in NLB Klik to avoid creating a
> duplicate payment.

### Output formats

Account balances support `--format tab` (default), `csv`, or `json`. Both transaction commands additionally support `xls`; account transactions also support `pdf`. Without `--output`, text formats print to stdout and report files are saved under `downloads/`, with the saved path reported on stderr.

Use `--output <path>` with either transaction command to save any supported format to an exact file path; its parent directory must already exist. Empty JSON exports contain `[]`, and empty CSV files contain their headers. Invalid report responses and failed or expired requests produce errors without writing partial results.

For example:

```bash
nlbcli accounts transactions <ACCOUNT_ID> --format xls --output ./transactions.xls
nlbcli accounts transactions <ACCOUNT_ID> --format csv --output ./transactions.csv
nlbcli accounts transactions <ACCOUNT_ID> --format json --output ./transactions.json
```

Exports are validated in a temporary file beside the destination, then atomically replace it. Failed or incomplete downloads leave an existing destination unchanged and remove temporary files. Progress and save messages go to stderr.

Account transaction text exports (`tab`, `csv`, `json`) retrieve all pages in the bank's order before printing any transaction data. Failed requests, repeated pages, and inconsistent pagination cause an error instead of a partial export.

Run `nlbcli --help` for all available commands and options.

Account and card transactions support stable JSON and CSV exports. Dates use
`YYYY-MM-DD`, monetary values are exact decimal **strings**, and missing values
are `null` in JSON (empty cells in CSV). See the [v1 export contract and JSON
Schemas](docs/transaction-exports.md) for field names, fixed CSV headers, examples,
and compatibility rules.

## How it works

Built with TypeScript using [Effect](https://effect.website/) for the CLI framework. Authentication goes through NLB Klik's push notification flow, then plain `fetch` requests with the saved session cookie handle all interactions. HTML responses are parsed with [Cheerio](https://cheerio.js.org/).

## License

[MIT](LICENSE)
