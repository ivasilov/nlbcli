#!/usr/bin/env node
import { Command } from "@effect/cli"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"
import packageJson from "../package.json"
import { command } from "./cli"

const cli = Command.run(command, {
  name: "nlbcli",
  version: packageJson.version,
})

cli(process.argv).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain)
