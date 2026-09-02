import readline from "node:readline"
import { BASE_URL, COOKIES_FILE } from "./constants"
import {
  type HttpResponse,
  isLoginRedirect,
  mergeCookieHeader,
  NlbHttpClient,
  nlbGet,
} from "./http"
import { loadState, saveCookies } from "./state"

function parseSetCookies(res: Response): string[] {
  return res.headers.getSetCookie?.() ?? []
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: login mirrors NLB's multi-step push protocol
export async function loginWithPush(username: string): Promise<string> {
  let cookies = ""

  // Step 1: GET login page to get session cookies
  console.log("Fetching login page...")
  const loginPageRes = await fetch(`${BASE_URL}/Account/Login`, {
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
      const redirectRes = await fetch(redirectUrl, {
        headers: { Cookie: cookies },
        redirect: "manual",
      })
      cookies = mergeCookieHeader(cookies, parseSetCookies(redirectRes))
    }
  }

  // Step 2: Send push notification
  console.log("Sending push notification...")
  const pushRes = await fetch(`${BASE_URL}/Account/SendLoginPushMessage`, {
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

  const pushData = (await pushRes.json()) as {
    Success: boolean
    Message: string
    OldMtoken?: boolean
  }
  if (!pushData.Success) {
    throw new Error(`Push notification failed: ${pushData.Message}`)
  }

  const loginId = pushData.Message
  console.log("Check your phone! Waiting up to 120s...")

  // Step 3: Poll /Account/CheckPushCallbackStatus until approved
  const start = Date.now()
  const timeout = 120_000
  const interval = 5000

  while (Date.now() - start < timeout) {
    await new Promise((r) => setTimeout(r, interval))

    const statusRes = await fetch(
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

    const statusData = (await statusRes.json()) as {
      Success: boolean
      Error?: string
    }

    if (statusData.Error) {
      throw new Error(`Push login failed: ${statusData.Error}`)
    }

    if (statusData.Success) {
      // Step 4: Submit the login form with the loginId
      console.log("Push approved! Completing login...")
      const loginRes = await fetch(`${BASE_URL}/Account/LoginUserNamePush`, {
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
      })
      cookies = mergeCookieHeader(cookies, parseSetCookies(loginRes))

      const loginData = (await loginRes.json()) as {
        UserAuthenticated: boolean
        Key?: string
        RedirectionUrl?: string
        ErrorMessage?: string
      }

      if (!loginData.UserAuthenticated) {
        throw new Error(
          `Login failed: ${loginData.ErrorMessage ?? "unknown error"}`
        )
      }

      // Step 5: Follow the redirection URL to get final session cookies
      if (loginData.RedirectionUrl) {
        const redirectUrl = loginData.RedirectionUrl.startsWith("http")
          ? loginData.RedirectionUrl
          : `${BASE_URL}${loginData.RedirectionUrl}`
        const finalRes = await fetch(redirectUrl, {
          headers: { Cookie: cookies },
          redirect: "manual",
        })
        cookies = mergeCookieHeader(cookies, parseSetCookies(finalRes))
      }

      console.log("Login successful!")
      saveCookies(cookies, username)
      console.log(`Session saved to ${COOKIES_FILE}`)
      return cookies
    }
  }

  throw new Error("Timed out waiting for push approval.")
}

export interface AuthenticatedPath {
  client: NlbHttpClient
  response: HttpResponse
}

export interface AuthenticatedPathDependencies {
  load?: typeof loadState
  login?: typeof loginWithPush
  persist?: typeof saveCookies
}

/**
 * Opens the command's target page as the session check, avoiding the otherwise
 * redundant balances-page request. The target is retried only after a confirmed
 * login redirect, never after a state-changing POST.
 */
export async function openAuthenticatedPath(
  urlPath: string,
  dependencies: AuthenticatedPathDependencies = {}
): Promise<AuthenticatedPath> {
  const load = dependencies.load ?? loadState
  const login = dependencies.login ?? loginWithPush
  const persist = dependencies.persist ?? saveCookies
  const state = load()
  if (!state) {
    throw new Error("No saved session. Run `nlbcli login` first.")
  }

  let client = new NlbHttpClient(state.cookie)
  let response = await client.get(urlPath)

  if (isLoginRedirect(response)) {
    if (!state.username) {
      throw new Error(
        "Session expired and no username is saved. Run `nlbcli login` first."
      )
    }
    console.log("Session expired, re-authenticating...")
    client = new NlbHttpClient(await login(state.username))
    response = await client.get(urlPath)
  } else {
    console.log("Using saved session.")
  }

  if (isLoginRedirect(response)) {
    throw new Error("NLB Klik redirected to login after re-authentication.")
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`NLB Klik returned HTTP ${response.status} for ${urlPath}.`)
  }

  persist(client.cookieHeader, state.username)
  return { client, response }
}

export async function getSession(_username?: string): Promise<string> {
  let username: string | undefined = _username
  const state = loadState()
  if (state) {
    const res = await nlbGet(
      "/Home/Balances?bankid=tutunska.banka@ibank",
      state.cookie
    )
    if (!isLoginRedirect(res)) {
      console.log("Using saved session.")
      return state.cookie
    }
    console.log("Session expired, re-authenticating...")
    username = username || state.username
  }
  if (!username) {
    throw new Error(
      "No username available. Run `login --username <user>` first."
    )
  }
  return loginWithPush(username)
}

export async function cmdLogin(username: string): Promise<void> {
  await loginWithPush(username)
}

export function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}
