---
name: nlbcli
description: Work with the NLB CLI tool for interacting with NLB bank accounts and cards. Use when the user wants to check balances, list transactions, manage accounts or cards, authenticate, or troubleshoot issues with nlbklik.com.mk.
---

# NLB Tutunska CLI

`nlbcli` is a CLI for interacting with NLB Tutunska (nlbklik.com.mk) internet banking. Use it to check account balances, list transactions, view card details, and more.

## Prerequisites

- The CLI must be installed and available as `nlbcli` in the user's PATH
- The user must have an NLB Klik account with push notification authentication enabled on their phone
- Session is stored at `~/.nlbcli/cookies.json` — if commands fail with session errors, the user needs to re-authenticate

## Authentication

Before using any commands, the user must log in:

```
nlbcli login [--username <user>]
```

This triggers a push notification to the user's phone. The CLI waits up to 120 seconds for approval. Once authenticated, the session cookie is saved and reused for subsequent commands.

If a command fails due to an expired session (HTTP 302 redirect), ask the user to run `nlbcli login` again.

## Available commands

```
nlbcli login [--username <user>]           # Authenticate via push notification
nlbcli accounts list                       # List account IDs
nlbcli accounts balance <id> [--format]    # Show account balance
nlbcli accounts transactions <id> [opts]   # List transactions (--start, --end, --format, --type, --name)
nlbcli accounts reservations <id>          # List pending reservations
nlbcli cards list                          # List card IDs
nlbcli cards balance <id>                  # Show card balance/details
nlbcli cards transactions <id>             # List card transactions
```

## Output formats

Use `--format` to control output:

- `tab` (default for balance) — tab-separated
- `csv` — comma-separated with proper escaping
- `json` — pretty-printed JSON, best for programmatic use by Claude
- `xls` (default for transactions) — downloads Excel file to `./downloads/`
- `pdf` — downloads PDF file to `./downloads/`

When running commands to process the data further, prefer `--format json` for structured output.

## Common workflows

### Check all account balances

1. Run `nlbcli accounts list` to get account IDs
2. For each account, run `nlbcli accounts balance <id> --format json`

### Get recent transactions

```
nlbcli accounts transactions <id> --start <dd.mm.yyyy> --end <dd.mm.yyyy> --format json
```

Dates use `dd.mm.yyyy` format (e.g., `01.03.2026`).

### Filter transactions

Use `--type` to filter by transaction type and `--name` to filter by name/description.

### Check card details

1. Run `nlbcli cards list` to get card IDs
2. Run `nlbcli cards balance <id>` for card details
3. Run `nlbcli cards transactions <id>` for card transaction history

## Troubleshooting

- **Session expired**: Run `nlbcli login` to re-authenticate
- **Command not found**: Ensure `nlbcli` is installed and in PATH
- **No data returned**: The account/card ID may be incorrect — verify with `accounts list` or `cards list`
