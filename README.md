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

This sends a push notification to your phone. Once approved, the session is saved to `~/.nlbcli/cookies.json` so subsequent commands work without re-authenticating. Expired sessions are detected automatically and trigger re-authentication.

> **Warning:** Your session cookie is stored in plaintext at `~/.nlbcli/cookies.json`. Keep this directory safe.

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

### Payments

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

Use `--format` to control output: `tab` (default), `csv`, `json`, `xls`, or `pdf`. File exports (`xls`, `pdf`) are saved to a `downloads/` directory when NLB returns a valid report file.

Run `nlbcli --help` for all available commands and options.

## How it works

Built with TypeScript using [Effect](https://effect.website/) for the CLI framework. Authentication goes through NLB Klik's push notification flow, then plain `fetch` requests with the saved session cookie handle all interactions. HTML responses are parsed with [Cheerio](https://cheerio.js.org/).

## License

[MIT](LICENSE)
