import { Args, Command, HelpDoc, Options, ValidationError } from "@effect/cli"
import { NodeContext } from "@effect/platform-node"
import { Cause, Effect, Exit, Option } from "effect"
import packageJson from "../package.json"
import { cmdLogin, getSession, openAuthenticatedPath, prompt } from "./auth"
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
  PaymentValidationError,
} from "./commands/payments"
import {
  cardTransactionFormats,
  printTransactionsResult,
  transactionDates,
  validateTransactionOptions,
} from "./commands/transactions"
import { DEFAULT_PROFILE } from "./constants"
import {
  authenticationError,
  bankResponseError,
  CliError,
  EXIT_CODES,
} from "./errors"
import { printCsv, printJson } from "./formatters"
import { loadState, validateProfile } from "./state"

const rootCommand = Command.make("nlbcli", {
  profile: Options.text("profile").pipe(
    Options.withDescription("Named login profile"),
    Options.mapTryCatch(validateProfile, (error) => HelpDoc.p(String(error))),
    Options.withDefault(DEFAULT_PROFILE)
  ),
  nonInteractive: Options.boolean("non-interactive").pipe(
    Options.withDescription(
      "Use only a saved session; never prompt or wait for push approval"
    )
  ),
})

function attempt<A>(run: () => Promise<A>) {
  return Effect.tryPromise({ try: run, catch: (error) => error })
}

function dataCommand<A>(
  run: (cookie: string) => Promise<A>,
  validate?: () => void
) {
  return Effect.gen(function* () {
    const { profile, nonInteractive } = yield* rootCommand
    return yield* attempt(async () => {
      validate?.()
      const cookie = await getSession(profile, undefined, { nonInteractive })
      try {
        return await run(cookie)
      } catch (error) {
        if (
          error instanceof CliError &&
          error.exitCode === EXIT_CODES.authentication
        ) {
          // Include the username even when the session expires after validation.
          throw authenticationError(profile, loadState(profile)?.username)
        }
        throw error
      }
    })
  })
}

// Shared options
const usernameOption = Options.text("username").pipe(
  Options.withDescription("NLB Klik username"),
  Options.optional
)

const formatOption = Options.choice("format", ["tab", "csv", "json"]).pipe(
  Options.withDescription("Output format (tab|csv|json)"),
  Options.withDefault("tab")
)

const transactionsFormatOption = Options.choice("format", [
  "tab",
  "csv",
  "json",
  "xls",
  "pdf",
]).pipe(
  Options.withDescription("Output format (tab|csv|json|xls|pdf)"),
  Options.withDefault("tab")
)

const outputOption = Options.text("output").pipe(
  Options.withDescription("Save export to this file path"),
  Options.optional
)

const bankDate = /^(\d{2})\.(\d{2})\.(\d{4})$/

function validateDate(value: string): string {
  const match = bankDate.exec(value)
  if (match) {
    const [, day, month, year] = match.map(Number)
    const date = new Date(year, month - 1, day)
    if (
      date.getFullYear() === year &&
      date.getMonth() === month - 1 &&
      date.getDate() === day
    ) {
      return value
    }
  }
  throw new Error("Expected a valid date in dd.mm.yyyy format.")
}

const dateOption = (name: string) =>
  Options.text(name).pipe(
    Options.mapTryCatch(validateDate, () =>
      HelpDoc.p(`--${name} must be a valid date in dd.mm.yyyy format.`)
    ),
    Options.optional
  )

const startOption = dateOption("start").pipe(
  Options.withDescription("Start date (dd.mm.yyyy)")
)

const endOption = dateOption("end").pipe(
  Options.withDescription("End date (dd.mm.yyyy)")
)

const typeOption = Options.choice("type", ["", "in", "out"]).pipe(
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
  throw new CliError(
    EXIT_CODES.arguments,
    `--${name} is required for ${type.toUpperCase()}.`
  )
}

function makePaymentParameters() {
  return {
    type: paymentTypeArg,
    source: Options.text("source").pipe(
      Options.withDescription("Source account ID")
    ),
    date: dateOption("date").pipe(
      Options.withDescription("Value date (dd.mm.yyyy; defaults to today)")
    ),
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
    Effect.gen(function* () {
      const { profile, nonInteractive } = yield* rootCommand
      if (nonInteractive) {
        return yield* Effect.fail(
          new CliError(
            EXIT_CODES.arguments,
            `Login requires push approval. Run \`nlbcli --profile ${profile} login\` without --non-interactive.`
          )
        )
      }
      yield* attempt(async () => {
        const u = Option.isSome(username)
          ? username.value
          : await prompt("Username: ")
        await cmdLogin(profile, u)
      })
    })
).pipe(Command.withDescription("Authenticate via push notification"))

// --- Account commands ---

const accountsListCommand = Command.make("list", {}, () =>
  dataCommand(async (cookie) => {
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
    dataCommand(async (cookie) => {
      const data = await cmdAccountBalance(cookie, id)
      if (!data) {
        throw bankResponseError(
          "No balance data found. Account ID may be invalid."
        )
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
    output: outputOption,
  },
  ({ id, start, end, format, type, name, output }) => {
    const dates = transactionDates(
      Option.getOrUndefined(start),
      Option.getOrUndefined(end)
    )
    const outputPath = Option.getOrUndefined(output)
    return dataCommand(
      async (cookie) => {
        const result = await cmdAccountTransactions(
          cookie,
          id,
          dates.start,
          dates.end,
          format,
          type,
          name,
          outputPath
        )
        printTransactionsResult(result, format)
      },
      () =>
        validateTransactionOptions(dates.start, dates.end, format, outputPath)
    )
  }
).pipe(Command.withDescription("List account transactions"))

const accountsReservationsCommand = Command.make(
  "reservations",
  { id: accountIdArg },
  ({ id }) =>
    dataCommand(async (cookie) => {
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
  dataCommand(async (cookie) => {
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
    dataCommand(async (cookie) => {
      const data = await cmdCardBalance(cookie, id)
      if (!data) {
        throw bankResponseError("No card data found. Card ID may be invalid.")
      }
      for (const [k, v] of Object.entries(data)) {
        console.log(`${k}: ${v}`)
      }
    })
).pipe(Command.withDescription("Show card balance and details"))

const cardsTransactionsCommand = Command.make(
  "transactions",
  {
    id: cardIdArg,
    start: startOption,
    end: endOption,
    format: Options.choice("format", ["tab", "csv", "json", "xls"]).pipe(
      Options.withDescription("Output format (tab|csv|json|xls)"),
      Options.withDefault("tab")
    ),
    output: outputOption,
  },
  ({ id, start, end, format, output }) => {
    const dates = transactionDates(
      Option.getOrUndefined(start),
      Option.getOrUndefined(end)
    )
    const outputPath = Option.getOrUndefined(output)
    return dataCommand(
      async (cookie) => {
        const result = await cmdCardTransactions(
          cookie,
          id,
          dates.start,
          dates.end,
          format,
          outputPath
        )
        printTransactionsResult(result, format)
      },
      () =>
        validateTransactionOptions(
          dates.start,
          dates.end,
          format,
          outputPath,
          cardTransactionFormats
        )
    )
  }
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
    Effect.gen(function* () {
      const { profile, nonInteractive } = yield* rootCommand
      if (mode === "send" && nonInteractive) {
        return yield* Effect.fail(
          new CliError(
            EXIT_CODES.arguments,
            "Sending a payment requires an interactive terminal and cannot use --non-interactive."
          )
        )
      }

      return yield* attempt(async () => {
        let request: PaymentRequest
        try {
          request = paymentRequestFromCli(parameters)
        } catch (error) {
          if (error instanceof PaymentValidationError) {
            throw new CliError(EXIT_CODES.arguments, error.message)
          }
          throw error
        }

        const result = await executePayment(request, mode, {
          openSession: (urlPath) =>
            openAuthenticatedPath(urlPath, { nonInteractive, profile }),
        })
        console.log(`STATUS: ${result.status}`)
        if (result.orderId) {
          console.log(`ORDER: ${result.orderId}`)
        }
        console.log(result.message)
        if (
          ["authorization-timeout", "rejected", "unknown"].includes(
            result.status
          )
        ) {
          throw bankResponseError(result.message)
        }
      })
    })
  ).pipe(
    Command.withDescription(
      mode === "create"
        ? "EXPERIMENTAL: Validate and save a payment order"
        : "EXPERIMENTAL: Review, sign, and submit a payment order"
    )
  )
}

const paymentsCommand = Command.make("payments").pipe(
  Command.withDescription(
    "EXPERIMENTAL: Create and send PP30, PP50, and PP53 payments"
  ),
  Command.withSubcommands([
    makePaymentCommand("create"),
    makePaymentCommand("send"),
  ])
)

// --- Root command ---

export const command = rootCommand.pipe(
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

const nonInteractiveFlag = /^--non-interactive(?:=.*)?$/i
const wizardFlag = /^--wizard(?:=.*)?$/i

export async function runCli(argv: string[]): Promise<number> {
  // Route the short alias through the framework's built-in version option.
  const args = [...argv]
  for (let i = 2; i < args.length && args[i] !== "--"; i++) {
    if (args[i] === "-v") {
      args[i] = "--version"
    }
  }
  // The framework's built-in wizard prompts before command handlers run.
  if (
    argv.slice(2).some((arg) => nonInteractiveFlag.test(arg)) &&
    argv.slice(2).some((arg) => wizardFlag.test(arg))
  ) {
    console.error("--wizard cannot be used with --non-interactive.")
    return EXIT_CODES.arguments
  }
  const result = await Effect.runPromiseExit(
    cli(args).pipe(Effect.provide(NodeContext.layer))
  )
  if (Exit.isSuccess(result)) {
    return EXIT_CODES.success
  }
  const error = Cause.squash(result.cause)
  if (ValidationError.isValidationError(error)) {
    return EXIT_CODES.arguments
  }
  if (error instanceof CliError) {
    console.error(error.message)
    return error.exitCode
  }
  console.error(
    error instanceof Error ? error.message : "Unexpected CLI error."
  )
  return EXIT_CODES.unexpected
}
