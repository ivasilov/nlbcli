#!/usr/bin/env node
import { Args, Command, Options } from "@effect/cli"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Effect, Option } from "effect"
import packageJson from "../package.json"
import { cmdLogin, getSession, prompt } from "./auth"
import {
  cmdAccountBalance,
  cmdAccountReservations,
  cmdAccountTransactions,
  cmdListAccounts,
} from "./commands/accounts"
import {
  cmdCardBalance,
  cmdCardTransactions,
  cmdListCards,
} from "./commands/cards"
import {
  defaultValueDate,
  executePayment,
  type PaymentMode,
  type PaymentRequest,
  type PaymentType,
} from "./commands/payments"
import { dateFmt } from "./constants"
import { printCsv, printJson, printTab } from "./formatters"

// Shared options
const usernameOption = Options.text("username").pipe(
  Options.withDescription("NLB Klik username"),
  Options.optional
)

const formatOption = Options.text("format").pipe(
  Options.withDescription("Output format (tab|csv|json|xls|pdf)"),
  Options.withDefault("tab")
)

const transactionsFormatOption = Options.text("format").pipe(
  Options.withDescription("Output format (tab|csv|json|xls|pdf)"),
  Options.withDefault("tab")
)

const startOption = Options.text("start").pipe(
  Options.withDescription("Start date (dd.mm.yyyy)"),
  Options.optional
)

const endOption = Options.text("end").pipe(
  Options.withDescription("End date (dd.mm.yyyy)"),
  Options.optional
)

const typeOption = Options.text("type").pipe(
  Options.withDescription("Filter by direction (in|out)"),
  Options.withDefault("")
)

const nameOption = Options.text("name").pipe(
  Options.withDescription("Filter by counterparty name"),
  Options.withDefault("")
)

// Shared args
const accountIdArg = Args.text({ name: "account-id" })
const cardIdArg = Args.text({ name: "card-id" })

function optionalText(name: string, description: string) {
  return Options.text(name).pipe(
    Options.withDescription(description),
    Options.optional
  )
}

const paymentTypeArg = Args.choice<PaymentType>(
  [
    ["pp30", "pp30"],
    ["pp50", "pp50"],
    ["pp53", "pp53"],
  ],
  { name: "type" }
)

function optionText(value: Option.Option<string>): string | undefined {
  return Option.isSome(value) ? value.value : undefined
}

function requiredPaymentOption(
  value: Option.Option<string>,
  name: string,
  type: PaymentType
): string {
  if (Option.isSome(value) && value.value.trim()) {
    return value.value
  }
  throw new Error(`--${name} is required for ${type.toUpperCase()}.`)
}

function makePaymentParameters() {
  return {
    type: paymentTypeArg,
    source: Options.text("source").pipe(
      Options.withDescription("Source account ID")
    ),
    date: optionalText("date", "Value date (dd.mm.yyyy; defaults to today)"),
    urgent: Options.boolean("urgent").pipe(
      Options.withDescription("Send through MIPS")
    ),
    destination: optionalText("destination", "Recipient payment account"),
    amount: optionalText("amount", "Payment amount in MKD"),
    purposeCode: optionalText("purpose-code", "PP30 payment purpose code"),
    purpose: optionalText("purpose", "Payment purpose description"),
    recipientName: optionalText(
      "recipient-name",
      "Recipient name for an external or unknown account"
    ),
    recipientAddress: optionalText(
      "recipient-address",
      "Recipient address for an external or unknown account"
    ),
    debitReference: optionalText(
      "debit-reference",
      "Ordering-party reference number"
    ),
    creditReference: optionalText(
      "credit-reference",
      "Recipient reference number"
    ),
    payeeAccount: optionalText("payee-account", "PP50 payee account"),
    budgetaryAccount: optionalText(
      "budgetary-account",
      "PP50 budgetary user account"
    ),
    incomeCodeAndProgram: optionalText(
      "income-code-program",
      "PP50 income code and program"
    ),
    folio: optionalText("folio", "PP53 folio number"),
  }
}

interface PaymentCliParameters {
  amount: Option.Option<string>
  budgetaryAccount: Option.Option<string>
  creditReference: Option.Option<string>
  date: Option.Option<string>
  debitReference: Option.Option<string>
  destination: Option.Option<string>
  folio: Option.Option<string>
  incomeCodeAndProgram: Option.Option<string>
  payeeAccount: Option.Option<string>
  purpose: Option.Option<string>
  purposeCode: Option.Option<string>
  recipientAddress: Option.Option<string>
  recipientName: Option.Option<string>
  source: string
  type: PaymentType
  urgent: boolean
}

function paymentRequestFromCli(options: PaymentCliParameters): PaymentRequest {
  const common = {
    sourceAccount: options.source,
    urgency: options.urgent,
    valueDate: optionText(options.date) ?? defaultValueDate(),
  }

  if (options.type === "pp53") {
    return {
      ...common,
      type: options.type,
      folioNumber: requiredPaymentOption(options.folio, "folio", options.type),
    }
  }

  const destinationAccount = requiredPaymentOption(
    options.destination,
    "destination",
    options.type
  )
  const amount = requiredPaymentOption(options.amount, "amount", options.type)
  const sharedRecipient = {
    ...common,
    amount,
    debitReference: optionText(options.debitReference),
    destinationAccount,
    purposeDescription: optionText(options.purpose),
    recipientAddress: optionText(options.recipientAddress),
    recipientName: optionText(options.recipientName),
  }

  if (options.type === "pp30") {
    return {
      ...sharedRecipient,
      type: options.type,
      creditReference: optionText(options.creditReference),
      purposeCode: requiredPaymentOption(
        options.purposeCode,
        "purpose-code",
        options.type
      ),
    }
  }

  return {
    ...sharedRecipient,
    type: options.type,
    budgetaryAccount: optionText(options.budgetaryAccount),
    incomeCodeAndProgram: optionText(options.incomeCodeAndProgram),
    payeeAccount: optionText(options.payeeAccount),
  }
}

// --- Login command ---

const loginCommand = Command.make(
  "login",
  { username: usernameOption },
  ({ username }) =>
    Effect.promise(async () => {
      const u = Option.isSome(username)
        ? username.value
        : await prompt("Username: ")
      await cmdLogin(u)
    })
).pipe(Command.withDescription("Authenticate via push notification"))

// --- Account commands ---

const accountsListCommand = Command.make("list", {}, () =>
  Effect.promise(async () => {
    const cookie = await getSession()
    const accounts = await cmdListAccounts(cookie)
    console.log("Accounts:")
    for (const a of accounts) {
      console.log(`  ${a}`)
    }
  })
).pipe(Command.withDescription("List all accounts"))

const accountsBalanceCommand = Command.make(
  "balance",
  { id: accountIdArg, format: formatOption },
  ({ id, format }) =>
    Effect.promise(async () => {
      const cookie = await getSession()
      const data = await cmdAccountBalance(cookie, id)
      if (!data) {
        console.error("No balance data found. Account ID may be invalid.")
        return
      }
      if (format === "json") {
        printJson([data])
      } else if (format === "csv") {
        printCsv([Object.values(data)], Object.keys(data))
      } else {
        for (const [k, v] of Object.entries(data)) {
          console.log(`${k}: ${v}`)
        }
      }
    })
).pipe(Command.withDescription("Show account balance"))

const accountsTransactionsCommand = Command.make(
  "transactions",
  {
    id: accountIdArg,
    start: startOption,
    end: endOption,
    format: transactionsFormatOption,
    type: typeOption,
    name: nameOption,
  },
  ({ id, start, end, format, type, name }) =>
    Effect.promise(async () => {
      const cookie = await getSession()
      const today = new Date()
      const monthAgo = new Date(today)
      monthAgo.setDate(monthAgo.getDate() - 30)
      const result = await cmdAccountTransactions(
        cookie,
        id,
        Option.getOrElse(start, () => dateFmt(monthAgo)),
        Option.getOrElse(end, () => dateFmt(today)),
        format,
        type,
        name
      )
      if (!result) {
        console.log("No transactions found.")
        return
      }
      if (result.kind === "file") {
        console.log(`SAVED: ${result.path} (${result.bytes} bytes)`)
      } else if (format === "json") {
        printJson(result.jsonRows)
      } else if (format === "csv") {
        printCsv(result.rows, result.headers)
      } else {
        printTab(result.rows)
      }
    })
).pipe(Command.withDescription("List account transactions"))

const accountsReservationsCommand = Command.make(
  "reservations",
  { id: accountIdArg },
  ({ id }) =>
    Effect.promise(async () => {
      const cookie = await getSession()
      const rows = await cmdAccountReservations(cookie, id)
      for (const r of rows) {
        console.log(r.join("\t"))
      }
    })
).pipe(Command.withDescription("List pending reservations"))

const accountsCommand = Command.make("accounts").pipe(
  Command.withDescription("Manage bank accounts"),
  Command.withSubcommands([
    accountsListCommand,
    accountsBalanceCommand,
    accountsTransactionsCommand,
    accountsReservationsCommand,
  ])
)

// --- Card commands ---

const cardsListCommand = Command.make("list", {}, () =>
  Effect.promise(async () => {
    const cookie = await getSession()
    const cards = await cmdListCards(cookie)
    console.log("Cards:")
    for (const c of cards) {
      console.log(`  ${c}`)
    }
  })
).pipe(Command.withDescription("List all cards"))

const cardsBalanceCommand = Command.make(
  "balance",
  { id: cardIdArg },
  ({ id }) =>
    Effect.promise(async () => {
      const cookie = await getSession()
      const data = await cmdCardBalance(cookie, id)
      if (!data) {
        console.error("No card data found. Card ID may be invalid.")
        return
      }
      for (const [k, v] of Object.entries(data)) {
        console.log(`${k}: ${v}`)
      }
    })
).pipe(Command.withDescription("Show card balance and details"))

const cardsTransactionsCommand = Command.make(
  "transactions",
  { id: cardIdArg },
  ({ id }) =>
    Effect.promise(async () => {
      const cookie = await getSession()
      const rows = await cmdCardTransactions(cookie, id)
      for (const r of rows) {
        console.log(r.join("\t"))
      }
    })
).pipe(Command.withDescription("List card transactions"))

const cardsCommand = Command.make("cards").pipe(
  Command.withDescription("Manage cards"),
  Command.withSubcommands([
    cardsListCommand,
    cardsBalanceCommand,
    cardsTransactionsCommand,
  ])
)

// --- Payment commands ---

function makePaymentCommand(mode: PaymentMode) {
  return Command.make(mode, makePaymentParameters(), (parameters) =>
    Effect.promise(async () => {
      const request = paymentRequestFromCli(parameters)
      const result = await executePayment(request, mode)
      console.log(`STATUS: ${result.status}`)
      if (result.orderId) {
        console.log(`ORDER: ${result.orderId}`)
      }
      console.log(result.message)
      if (
        ["authorization-timeout", "rejected", "unknown"].includes(result.status)
      ) {
        process.exitCode = 1
      }
    })
  ).pipe(
    Command.withDescription(
      mode === "create"
        ? "Validate and save a payment order"
        : "Review, sign, and submit a payment order"
    )
  )
}

const paymentsCommand = Command.make("payments").pipe(
  Command.withDescription("Create and send PP30, PP50, and PP53 payments"),
  Command.withSubcommands([
    makePaymentCommand("create"),
    makePaymentCommand("send"),
  ])
)

// --- Root command ---

const command = Command.make("nlbcli").pipe(
  Command.withDescription("NLB Tutunska CLI client"),
  Command.withSubcommands([
    loginCommand,
    accountsCommand,
    cardsCommand,
    paymentsCommand,
  ])
)

// --- Run ---

const cli = Command.run(command, {
  name: "nlbcli",
  version: packageJson.version,
})

cli(process.argv).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain)
