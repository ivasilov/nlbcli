import readline from "node:readline"
import { BASE_URL, DEFAULT_PROFILE } from "./constants"
import {
  authenticationError,
  bankResponseError,
  CliError,
  EXIT_CODES,
} from "./errors"
import {
  bankFetch,
  type HttpResponse,
  isAuthenticationResponse,
  mergeCookieHeader,
  NlbHttpClient,
  nlbGet,
  readBankJson,
  requireBalancesPage,
} from "./http"
import {
  getSessionFile,
  loadState,
  saveCookies,
  validateProfile,
} from "./state"

function parseSetCookies(res: Response): string[] {
  return res.headers.getSetCookie?.() ?? []
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The push login protocol has several sequential authentication steps.
export async function loginWithPush(
  profile: string,
  username: string
): Promise<string> {
  validateProfile(profile)
  let cookies = ""

  // Step 1: GET login page to get session cookies
  console.error("Fetching login page...")
  const loginPageRes = await bankFetch(`${BASE_URL}/Account/Login`, {
    redirect: "manual",
  })
  cookies = mergeCookieHeader(cookies, parseSetCookies(loginPageRes))

  // Follow redirect if needed
  if (loginPageRes.status >= 300 && loginPageRes.status < 400) {
    const location = loginPageRes.headers.get("location")
    if (location) {
      const redirectUrl = location.startsWith("http")
        ? location
        : `${BASE_URL}${location}`
      const redirectRes = await bankFetch(redirectUrl, {
        headers: { Cookie: cookies },
        redirect: "manual",
      })
      cookies = mergeCookieHeader(cookies, parseSetCookies(redirectRes))
    }
  }

  // Step 2: Send push notification
  console.error("Sending push notification...")
  const pushRes = await bankFetch(`${BASE_URL}/Account/SendLoginPushMessage`, {
    method: "POST",
    headers: {
      Cookie: cookies,
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Requested-With": "XMLHttpRequest",
    },
    body: new URLSearchParams({ UserName: username }).toString(),
    redirect: "manual",
  })
  cookies = mergeCookieHeader(cookies, parseSetCookies(pushRes))

  const pushData = await readBankJson(pushRes)
  if (
    typeof pushData.Success !== "boolean" ||
    typeof pushData.Message !== "string"
  ) {
    throw bankResponseError(
      "NLB returned an invalid push notification response."
    )
  }
  if (!pushData.Success) {
    throw new CliError(
      EXIT_CODES.authentication,
      `Push notification failed: ${pushData.Message}`
    )
  }

  const loginId = pushData.Message
  console.error("Check your phone! Waiting up to 120s...")

  // Step 3: Poll /Account/CheckPushCallbackStatus until approved
  const start = Date.now()
  const timeout = 120_000
  const interval = 5000

  while (Date.now() - start < timeout) {
    await new Promise((r) => setTimeout(r, interval))

    const statusRes = await bankFetch(
      `${BASE_URL}/Account/CheckPushCallbackStatus`,
      {
        method: "POST",
        headers: {
          Cookie: cookies,
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: new URLSearchParams({ loginId }).toString(),
        redirect: "manual",
      }
    )
    cookies = mergeCookieHeader(cookies, parseSetCookies(statusRes))

    const statusData = await readBankJson(statusRes)
    if (typeof statusData.Success !== "boolean") {
      throw bankResponseError("NLB returned an invalid push approval response.")
    }

    if (statusData.Error) {
      throw new CliError(
        EXIT_CODES.authentication,
        `Push login failed: ${statusData.Error}`
      )
    }

    if (statusData.Success) {
      // Step 4: Submit the login form with the loginId
      console.error("Push approved! Completing login...")
      const loginRes = await bankFetch(
        `${BASE_URL}/Account/LoginUserNamePush`,
        {
          method: "POST",
          headers: {
            Cookie: cookies,
            "Content-Type": "application/x-www-form-urlencoded",
            "X-Requested-With": "XMLHttpRequest",
          },
          body: new URLSearchParams({
            UserName: username,
            LoginId: loginId,
          }).toString(),
          redirect: "manual",
        }
      )
      cookies = mergeCookieHeader(cookies, parseSetCookies(loginRes))

      const loginData = await readBankJson(loginRes)
      if (
        typeof loginData.UserAuthenticated !== "boolean" ||
        (loginData.RedirectionUrl !== undefined &&
          typeof loginData.RedirectionUrl !== "string")
      ) {
        throw bankResponseError("NLB returned an invalid login response.")
      }

      if (!loginData.UserAuthenticated) {
        throw new CliError(
          EXIT_CODES.authentication,
          `Login failed: ${loginData.ErrorMessage ?? "unknown error"}`
        )
      }

      // Step 5: Follow the redirection URL to get final session cookies
      if (
        typeof loginData.RedirectionUrl === "string" &&
        loginData.RedirectionUrl
      ) {
        const redirectUrl = loginData.RedirectionUrl.startsWith("http")
          ? loginData.RedirectionUrl
          : `${BASE_URL}${loginData.RedirectionUrl}`
        const finalRes = await bankFetch(redirectUrl, {
          headers: { Cookie: cookies },
          redirect: "manual",
        })
        cookies = mergeCookieHeader(cookies, parseSetCookies(finalRes))
      }

      console.error("Login successful!")
      saveCookies(profile, cookies, username)
      console.error(`Session saved to ${getSessionFile(profile)}`)
      return cookies
    }
  }

  throw new CliError(
    EXIT_CODES.authentication,
    "Timed out waiting for push approval."
  )
}

export interface AuthenticatedPath {
  client: NlbHttpClient
  response: HttpResponse
}

export interface AuthenticatedPathOptions {
  load?: typeof loadState
  login?: typeof loginWithPush
  nonInteractive?: boolean
  persist?: typeof saveCookies
  profile?: string
}

async function tryTarget(
  client: NlbHttpClient,
  urlPath: string
): Promise<HttpResponse | null> {
  try {
    const response = await client.get(urlPath)
    return isAuthenticationResponse(response) ? null : response
  } catch (error) {
    if (
      error instanceof CliError &&
      error.exitCode === EXIT_CODES.authentication
    ) {
      return null
    }
    throw error
  }
}

/**
 * Uses the requested payment form as the session check so payment commands do
 * not fetch the balances page or any unrelated payment form.
 */
export async function openAuthenticatedPath(
  urlPath: string,
  options: AuthenticatedPathOptions = {}
): Promise<AuthenticatedPath> {
  const profile = options.profile ?? DEFAULT_PROFILE
  const load = options.load ?? loadState
  const login = options.login ?? loginWithPush
  const persist = options.persist ?? saveCookies
  const state = load(profile)
  if (!state) {
    throw authenticationError(profile)
  }

  let client = new NlbHttpClient(state.cookie)
  let response = await tryTarget(client, urlPath)
  if (response) {
    console.error("Using saved session.")
  } else {
    if (options.nonInteractive || !state.username) {
      throw authenticationError(profile, state.username)
    }
    console.error("Session expired, re-authenticating...")
    client = new NlbHttpClient(await login(profile, state.username))
    response = await tryTarget(client, urlPath)
  }

  if (!response) {
    throw authenticationError(profile, state.username)
  }

  persist(profile, client.cookieHeader, state.username)
  return { client, response }
}

export async function getSession(
  profile: string,
  _username?: string,
  { nonInteractive = false }: { nonInteractive?: boolean } = {}
): Promise<string> {
  let username = _username
  const state = loadState(profile)
  if (state) {
    username ||= state.username
    try {
      requireBalancesPage(
        await nlbGet("/Home/Balances?bankid=tutunska.banka@ibank", state.cookie)
      )
      console.error("Using saved session.")
      return state.cookie
    } catch (error) {
      if (
        !(error instanceof CliError) ||
        error.exitCode !== EXIT_CODES.authentication
      ) {
        throw error
      }
    }
    if (!nonInteractive) {
      console.error("Session expired, re-authenticating...")
    }
  }
  if (nonInteractive || !username) {
    throw authenticationError(profile, username)
  }
  return loginWithPush(profile, username)
}

export async function cmdLogin(
  profile: string,
  username: string
): Promise<void> {
  await loginWithPush(profile, username)
}

export function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}
