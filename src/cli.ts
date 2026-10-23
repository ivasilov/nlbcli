import { Args, Command, HelpDoc, Options, ValidationError } from "@effect/cli"
import { NodeContext } from "@effect/platform-node"
import { Cause, Effect, Exit, Option } from "effect"
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
import { DEFAULT_PROFILE, dateFmt } from "./constants"
import {
  authenticationError,
  bankResponseError,
  CliError,
  EXIT_CODES,
} from "./errors"
import { printCsv, printJson, printTab } from "./formatters"
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

function dataCommand<A>(run: (cookie: string) => Promise<A>) {
  return Effect.gen(function* () {
    const { profile, nonInteractive } = yield* rootCommand
    return yield* attempt(async () => {
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
  },
  ({ id, start, end, format, type, name }) =>
    dataCommand(async (cookie) => {
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
        if (format === "json") {
          printJson([])
        }
        console.error("No transactions found.")
        return
      }
      if (result.kind === "file") {
        console.error(`SAVED: ${result.path} (${result.bytes} bytes)`)
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
  { id: cardIdArg },
  ({ id }) =>
    dataCommand(async (cookie) => {
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

// --- Root command ---

export const command = rootCommand.pipe(
  Command.withDescription("NLB Tutunska CLI client"),
  Command.withSubcommands([loginCommand, accountsCommand, cardsCommand])
)

// --- Run ---

const cli = Command.run(command, {
  name: "nlbcli",
  version: packageJson.version,
})

const nonInteractiveFlag = /^--non-interactive(?:=.*)?$/i
const wizardFlag = /^--wizard(?:=.*)?$/i

export async function runCli(argv: string[]): Promise<number> {
  // The framework's built-in wizard prompts before command handlers run.
  if (
    argv.slice(2).some((arg) => nonInteractiveFlag.test(arg)) &&
    argv.slice(2).some((arg) => wizardFlag.test(arg))
  ) {
    console.error("--wizard cannot be used with --non-interactive.")
    return EXIT_CODES.arguments
  }
  const result = await Effect.runPromiseExit(
    cli(argv).pipe(Effect.provide(NodeContext.layer))
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
