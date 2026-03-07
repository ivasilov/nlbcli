# nlbcli


**Unofficial** CLI for [NLB Klik](https://www.nlbklik.com.mk) (НЛБ Банка АД Скопје). Check balances, list transactions, view card details, and more — straight from the terminal. 

This is a Typescript implementation of the [nlbcli](https://github.com/whoeverest/nlbcli) which was written in Python, updated to support notification-based login.

> [!CAUTION]
> This tool is not developed or endorsed by НЛБ Банка АД Скопје. Use at your own risk.

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18

## Install

```bash
npm install nlbcli -g
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

### Output formats

Use `--format` to control output: `tab` (default for balance), `csv`, `json`, `xls` (default for transactions), `pdf`. File exports (`xls`, `pdf`) are saved to a `downloads/` directory.

Run `nlbcli --help` for all available commands and options.

## How it works

Built with TypeScript using [Effect](https://effect.website/) for the CLI framework. Authentication goes through NLB Klik's push notification flow, then plain `fetch` requests with the saved session cookie handle all interactions. HTML responses are parsed with [Cheerio](https://cheerio.js.org/).

## License

[MIT](LICENSE)
