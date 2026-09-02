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

// --- Root command ---

const command = Command.make("nlbcli").pipe(
  Command.withDescription("NLB Tutunska CLI client"),
  Command.withSubcommands([loginCommand, accountsCommand, cardsCommand])
)

// --- Run ---

const cli = Command.run(command, {
  name: "nlbcli",
  version: packageJson.version,
})

cli(process.argv).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain)
