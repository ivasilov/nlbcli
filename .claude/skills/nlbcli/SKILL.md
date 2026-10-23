---
name: nlbcli
description: Use for NLB Klik account and card balances, transaction exports, pending reservations, payment orders, login, and CLI or session troubleshooting for nlbklik.com.mk.
---

# NLB Klik CLI

Use `nlbcli` to read NLB Klik banking data and create or send PP30, PP50, and PP53 payment orders. Follow the shared setup, then the workflow for the user's request.

## Select the profile

1. Check that `nlbcli` is available. If it is missing, install it with `npm install --global nlbcli` (Node.js >= 18 is required).
2. Use the user's selected profile throughout the task. Put `--profile <PROFILE>` before the command; omit it only to use `default`. Each profile has its own session and saved username, with no fallback to another profile.
3. For command options, consult the installed CLI with `<command> --help`, such as `nlbcli cards transactions --help`. Choose the data-read or payment workflow below before running a bank command.

## Read accounts and cards

1. Add `--non-interactive` to every data read so it uses only the saved session and returns without prompting or requesting push approval. Discover IDs in the selected profile when needed:

   ```sh
   nlbcli --profile <PROFILE> --non-interactive accounts list
   nlbcli --profile <PROFILE> --non-interactive cards list
   ```

2. Run the requested read with an ID from that profile. For all account balances, run the balance command for each account returned by `accounts list`:

   ```sh
   nlbcli --profile <PROFILE> --non-interactive accounts balance <ACCOUNT_ID> --format json
   nlbcli --profile <PROFILE> --non-interactive accounts reservations <ACCOUNT_ID>
   nlbcli --profile <PROFILE> --non-interactive cards balance <CARD_ID>
   ```

   For transactions, use `accounts transactions <ACCOUNT_ID>` or `cards transactions <CARD_ID>`. Prefer `--format json` for processing data. Both accept `--start` and `--end` in `dd.mm.yyyy`; omitted bounds default to 30 days ago and today. Account transactions also support `--name` and `--type in|out`.

3. Check the exit code before interpreting stdout. Data is on stdout; progress and errors are on stderr. A valid empty transaction array (`[]`) is a successful result. Report the selected profile, date range when relevant, and requested findings or saved export path.

### Export transactions

Choose JSON or CSV for structured data, XLS for a bank report, or PDF for an **account** bank report. Transactions default to `tab`. Account balances accept `tab`, `csv`, or `json`; lists, reservations, and card balances print text without a format option.

Both transaction commands collect all pages for tab/JSON/CSV and accept `--output <PATH>`. Ensure the parent directory exists. Without `--output`, text goes to stdout and reports go to `./downloads/`; save confirmations go to stderr. Failed exports preserve any existing destination.

JSON/CSV transaction dates use `YYYY-MM-DD`, monetary values are exact decimal strings, and missing values are `null` in JSON or empty CSV cells. Use decimal arithmetic for monetary calculations.

Before writing an importer, calculating transaction totals, or validating exports, read the [v1 export contract](https://github.com/ivasilov/nlbcli/blob/master/docs/transaction-exports.md) for the account/card schemas, normalization rules, and validation guarantees. Consult its compatibility section when changing export consumers or the export format.

## Recover a failed command

| Exit code | Next action |
| --- | --- |
| `3` — authentication | Have the user run the login command printed on stderr interactively, approve the phone notification, then retry the data read in the same profile. |
| `2` — arguments | Correct the arguments using that command's `--help`; validate dates and the output directory. |
| `4` — network | Report the failure. A read may be retried; a payment requires the outcome check below first. |
| `5` — bank response | Report the bank response error. For a payment, inspect its status and verify the order before considering another attempt. |
| `1` — local/runtime | Report the diagnostic and resolve the local cause before retrying. |

Login takes the form `nlbcli --profile <PROFILE> login --username <USERNAME>` and waits up to 120 seconds for push approval. Use the saved username from the printed instruction when available. Run login without `--non-interactive`; the CLI also rejects that flag with `--wizard` or `payments send`.

For an invalid account/card ID, rediscover IDs with the corresponding list command. Treat valid empty transaction results as empty data, and check the requested range and filters when the result is unexpected.

## Create or send a payment

Payments are experimental and write bank state. `create` saves an unsigned order; `send` creates, signs, and submits an order. Choose one operation for the user's intent: running `send` after `create` starts another order rather than signing the saved draft.

1. Establish whether the user wants an unsigned order or explicitly wants to submit a payment. Gather the source account and the fields for the chosen type. Use `nlbcli payments create --help` or `nlbcli payments send --help` for available flags:
   - PP30 requires destination, MKD amount, and purpose code.
   - PP50 requires destination and MKD amount; NLB can derive the income code/program from a supplied payee or budgetary account.
   - PP53 requires a folio number; NLB resolves its total and number of orders.
   - External or unknown destinations require recipient name and address.

2. Execute the chosen operation in the selected profile. For `send`, use an interactive terminal and leave the displayed review and `SEND` confirmation to the user. Never bypass that confirmation. The user completes authorization in mKlik.

3. Read the `STATUS`, order ID when present, and message. Report an unsigned draft as saved, a cancellation as cancelled, and pending authorization as pending. Stay with the user through the CLI's authorization result; have them verify the final payment status in NLB Klik.

**Unknown outcome:** after an unknown result, authorization timeout, or network failure during either create or send, stop payment attempts and have the user verify the order in NLB Klik before any retry. An error exit code alone does not prove that no order was created.
