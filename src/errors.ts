export const EXIT_CODES = {
  success: 0,
  unexpected: 1,
  arguments: 2,
  authentication: 3,
  network: 4,
  bankResponse: 5,
} as const

export class CliError extends Error {
  readonly exitCode: number

  constructor(exitCode: number, message: string) {
    super(message)
    this.name = "CliError"
    this.exitCode = exitCode
  }
}

export function authenticationError(
  profile = "default",
  username?: string
): CliError {
  const login = username
    ? `nlbcli --profile ${profile} login --username '${username.replaceAll("'", "'\\''")}'`
    : `nlbcli --profile ${profile} login --username <user>`
  return new CliError(
    EXIT_CODES.authentication,
    `No valid saved session for profile "${profile}" (missing or expired). Run \`${login}\` to log in.`
  )
}

export function bankResponseError(message: string): CliError {
  return new CliError(EXIT_CODES.bankResponse, message)
}
