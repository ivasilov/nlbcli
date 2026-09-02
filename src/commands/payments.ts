import { type CheerioAPI, load } from "cheerio"
import { type AuthenticatedPath, openAuthenticatedPath, prompt } from "../auth"
import { dateFmt } from "../constants"
import { type HttpResponse, isLoginRedirect, type NlbHttpClient } from "../http"

export type PaymentType = "pp30" | "pp50" | "pp53"
export type PaymentMode = "create" | "send"

interface CommonPaymentRequest {
  sourceAccount: string
  urgency: boolean
  valueDate: string
}

export interface PP30PaymentRequest extends CommonPaymentRequest {
  amount: string
  creditReference?: string
  debitReference?: string
  destinationAccount: string
  purposeCode: string
  purposeDescription?: string
  recipientAddress?: string
  recipientName?: string
  type: "pp30"
}

export interface PP50PaymentRequest extends CommonPaymentRequest {
  amount: string
  budgetaryAccount?: string
  debitReference?: string
  destinationAccount: string
  incomeCodeAndProgram?: string
  payeeAccount?: string
  purposeDescription?: string
  recipientAddress?: string
  recipientName?: string
  type: "pp50"
}

export interface PP53PaymentRequest extends CommonPaymentRequest {
  folioNumber: string
  type: "pp53"
}

export type PaymentRequest =
  | PP30PaymentRequest
  | PP50PaymentRequest
  | PP53PaymentRequest

export type PaymentStatus =
  | "approved"
  | "authorization-timeout"
  | "awaiting-authorization"
  | "cancelled"
  | "draft-created"
  | "rejected"
  | "submitted"
  | "unknown"

export interface PaymentResult {
  message: string
  orderId?: string
  status: PaymentStatus
  type: PaymentType
}

export interface PaymentSummary {
  amount: string
  destination?: string
  folioNumber?: string
  numberOfOrders?: string
  recipient?: string
  source: string
  type: PaymentType
  urgency: boolean
  valueDate: string
}

export interface PreparedPayment {
  client: NlbHttpClient
  formPath: string
  payload: Record<string, string>
  summary: PaymentSummary
  type: PaymentType
}

export type SessionOpener = (urlPath: string) => Promise<AuthenticatedPath>

export interface PrepareOptions {
  openSession?: SessionOpener
  today?: Date
}

export interface PollOptions {
  intervalMs?: number
  sleep?: (milliseconds: number) => Promise<void>
  timeoutMs?: number
}

export interface ExecutePaymentOptions extends PrepareOptions {
  confirm?: (summary: PaymentSummary) => Promise<boolean>
  poll?: PollOptions
}

interface RecipientData {
  bank: string
  recipientAddress: string
  recipientName: string
}

const PAYMENT_PATHS: Record<PaymentType, string> = {
  pp30: "/DpsTransferFunds/Order",
  pp50: "/DpsTransferFunds/PP50Order",
  pp53: "/DpsTransferFunds/PP53Order",
}

const EXTERNAL_RECIPIENT_NAMES = new Set([
  "",
  "Платежна сметка од друга банка",
  "Трансакциска сметка од друга банка",
])

const MAX_AMOUNT = 2_147_483_647
const DATE_PATTERN = /^(\d{2})\.(\d{2})\.(\d{4})$/
const DIGITS_PATTERN = /^\d+$/
const DESTINATION_SEPARATORS_PATTERN = /[\s-]/g
const AMOUNT_PATTERN = /^\d+(?:\.\d{1,2})?$/
const THOUSANDS_SEPARATOR_PATTERN = /,/g
const LEGACY_UNICODE_PATTERN = /%u([0-9a-f]{4})/gi
const WHITESPACE_PATTERN = /\s+/g
const APPROVED_STATUS_PATTERN = /успеш|одобрен|approved|completed|success/i
const REJECTED_STATUS_PATTERN =
  /неуспеш|одбиен|одбиено|rejected|declined|error|грешк/i
const AUTHORIZATION_HINT_PATTERN = /push|mklik|мклик|мобил|авториза|потпиш/i
const TASK_CALL_PATTERN = /GetLongRunningTaskStatus\(\s*["']([^"']+)/i
const TASK_ASSIGNMENT_PATTERN = /(?:taskid|taskId)\s*[:=]\s*["']([^"']+)/i
const ORDER_ID_PATTERNS = [
  /(?:OrderId|PaymentOrderId|TransactionId)["']?\s*(?:value=|[:=])\s*["']([\w-]+)/i,
  /\/PaymentOrders\/Details\/([\w-]+)/i,
]

export class AmbiguousPaymentError extends Error {
  constructor(message: string) {
    super(
      `${message} Do not retry: verify the order in NLB Klik before taking any further action.`
    )
    this.name = "AmbiguousPaymentError"
  }
}

export class PaymentValidationError extends Error {
  readonly errors: string[]

  constructor(errors: string[]) {
    super(errors.join("\n"))
    this.name = "PaymentValidationError"
    this.errors = errors
  }
}

function nonEmpty(value: string | undefined): string {
  return value?.trim() ?? ""
}

function formValue($: CheerioAPI, name: string, override?: string): string {
  if (override !== undefined) {
    return override
  }
  const field = $(`#form_EntryForm [name="${name}"]`).first()
  return nonEmpty(field.val()?.toString() ?? field.attr("value"))
}

function requiredFormValue($: CheerioAPI, name: string): string {
  const value = formValue($, name)
  if (!value) {
    throw new Error(`NLB payment form is missing the required ${name} value.`)
  }
  return value
}

function basePayload(
  $: CheerioAPI,
  request: PaymentRequest,
  sourceAccount: string
): Record<string, string> {
  return {
    TemplateId: formValue($, "TemplateId"),
    TemplateName: formValue($, "TemplateName"),
    SaveAsNew: formValue($, "SaveAsNew") || "True",
    __RequestVerificationToken: requiredFormValue(
      $,
      "__RequestVerificationToken"
    ),
    OrderingPartyName: requiredFormValue($, "OrderingPartyName"),
    OrderingPartyAddress: formValue($, "OrderingPartyAddress"),
    SourceAccount: sourceAccount,
    OrderingPartyBank: formValue($, "OrderingPartyBank"),
    Currency: formValue($, "Currency") || "MKD",
    ValueDate: request.valueDate,
    ...(request.urgency ? { Urgency: "True" } : {}),
  }
}

function findSourceAccount($: CheerioAPI, requestedAccount: string): string {
  const requested = requestedAccount.trim()
  const accounts = $("#form_EntryForm select[name='SourceAccount'] option")
    .map((_index, option) => nonEmpty($(option).attr("value")))
    .get()
    .filter(Boolean)

  const source = accounts.find((account) => account === requested)
  if (!source) {
    throw new Error(
      "The requested source account is not available for this payment type."
    )
  }
  return source
}

export function normalizeDestinationAccount(account: string): string {
  const compact = account.replace(DESTINATION_SEPARATORS_PATTERN, "")
  if (
    !DIGITS_PATTERN.test(compact) ||
    compact.length < 5 ||
    compact.length > 15
  ) {
    throw new Error(
      "Destination account must contain at most 15 digits in DDD-DDDDDDDDDD-DD format."
    )
  }

  const padded = `${compact.slice(0, 3)}${compact.slice(3).padStart(12, "0")}`
  return `${padded.slice(0, 3)}-${padded.slice(3, 13)}-${padded.slice(13)}`
}

export function normalizeAmount(amount: string): string {
  const compact = amount.replace(THOUSANDS_SEPARATOR_PATTERN, "").trim()
  if (!AMOUNT_PATTERN.test(compact)) {
    throw new Error(
      "Amount must be a positive MKD value with at most 2 decimals."
    )
  }
  const numeric = Number(compact)
  if (!Number.isFinite(numeric) || numeric <= 0 || numeric > MAX_AMOUNT) {
    throw new Error(
      `Amount must be greater than 0 and no more than ${MAX_AMOUNT.toFixed(2)} MKD.`
    )
  }
  return numeric.toFixed(2)
}

export function validateValueDate(value: string, today = new Date()): string {
  const match = DATE_PATTERN.exec(value)
  if (!match) {
    throw new Error("Value date must use dd.mm.yyyy format.")
  }

  const day = Number(match[1])
  const month = Number(match[2])
  const year = Number(match[3])
  const parsed = new Date(year, month - 1, day)
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    throw new Error("Value date is not a valid calendar date.")
  }

  const current = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate()
  )
  if (parsed < current) {
    throw new Error("Value date cannot be in the past.")
  }
  return value
}

function decodeServerText(value: unknown): string {
  if (typeof value !== "string") {
    return ""
  }
  const unicodeDecoded = value.replace(LEGACY_UNICODE_PATTERN, (_match, hex) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  )
  try {
    return decodeURIComponent(unicodeDecoded).trim()
  } catch {
    return unicodeDecoded.trim()
  }
}

async function postJson<T>(
  client: NlbHttpClient,
  path: string,
  data: Record<string, string>
): Promise<T> {
  const response = await client.post(path, data)
  if (isLoginRedirect(response)) {
    throw new Error("NLB Klik session expired while preparing the payment.")
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`NLB Klik returned HTTP ${response.status} for ${path}.`)
  }
  try {
    return JSON.parse(response.body.toString("utf-8")) as T
  } catch {
    throw new Error(`NLB Klik returned an invalid JSON response for ${path}.`)
  }
}

async function resolveRecipient(
  client: NlbHttpClient,
  destinationAccount: string,
  suppliedName?: string,
  suppliedAddress?: string
): Promise<RecipientData> {
  const response = await postJson<{
    RecipientAddress?: string
    RecipientBank?: string
    RecipientName?: string
  }>(client, "/Csp/RecipientDataAjax", {
    accountFilter: destinationAccount,
  })

  const resolvedName = decodeServerText(response.RecipientName)
  const resolvedAddress = decodeServerText(response.RecipientAddress)
  const recipientName = EXTERNAL_RECIPIENT_NAMES.has(resolvedName)
    ? nonEmpty(suppliedName)
    : resolvedName
  const recipientAddress = resolvedAddress || nonEmpty(suppliedAddress)
  const errors: string[] = []
  if (!recipientName) {
    errors.push(
      "--recipient-name is required for an external or unknown account."
    )
  }
  if (!recipientAddress) {
    errors.push(
      "--recipient-address is required for an external or unknown account."
    )
  }
  if (errors.length > 0) {
    throw new PaymentValidationError(errors)
  }

  return {
    bank: decodeServerText(response.RecipientBank),
    recipientAddress,
    recipientName,
  }
}

function validateLength(
  value: string | undefined,
  name: string,
  maximum: number
): void {
  if (value && value.length > maximum) {
    throw new PaymentValidationError([
      `--${name} must be no more than ${maximum} characters.`,
    ])
  }
}

async function deriveIncomeCode(
  client: NlbHttpClient,
  request: PP50PaymentRequest
): Promise<string> {
  const supplied = nonEmpty(request.incomeCodeAndProgram)
  if (supplied) {
    return supplied
  }

  const accounts = [request.payeeAccount, request.budgetaryAccount]
    .map(nonEmpty)
    .filter(Boolean)
  if (accounts.length === 0) {
    return ""
  }

  const derived = new Set<string>()
  for (const account of accounts) {
    const response = await postJson<{ Response?: string; Success?: boolean }>(
      client,
      "/Csp/ValidatePP50Account",
      { account }
    )
    const value = decodeServerText(response.Response)
    if (response.Success && value) {
      derived.add(value)
    }
  }

  if (derived.size === 0) {
    throw new PaymentValidationError([
      "NLB could not derive the PP50 income code and program; provide --income-code-program.",
    ])
  }
  if (derived.size > 1) {
    throw new PaymentValidationError([
      "The PP50 payee and budgetary accounts resolve to conflicting income codes.",
    ])
  }
  return [...derived][0]
}

async function resolveFolio(
  client: NlbHttpClient,
  folioNumber: string
): Promise<{ amount: string; numberOfOrders: string }> {
  const response = await postJson<{
    Error?: string
    NumberOfOrders?: string
    TotalAmount?: string
  }>(client, "/Csp/GetPiomResponse", {
    portfolioNumber: folioNumber,
  })
  const numberOfOrders = nonEmpty(response.NumberOfOrders)
  const rawAmount = nonEmpty(response.TotalAmount)
  if (
    !DIGITS_PATTERN.test(numberOfOrders) ||
    Number(numberOfOrders) <= 0 ||
    !rawAmount
  ) {
    throw new PaymentValidationError([
      decodeServerText(response.Error) ||
        "NLB did not return valid payment details for that folio number.",
    ])
  }
  return { amount: normalizeAmount(rawAmount), numberOfOrders }
}

function parseForm(response: AuthenticatedPath): CheerioAPI {
  const html = response.response.body.toString("utf-8")
  const $ = load(html)
  if ($("#form_EntryForm").length === 0) {
    throw new Error("NLB Klik did not return the expected payment form.")
  }
  return $
}

function validatePaymentRequestLocally(
  request: PaymentRequest,
  today: Date
): void {
  validateValueDate(request.valueDate, today)
  if (!request.sourceAccount.trim()) {
    throw new PaymentValidationError(["--source cannot be empty."])
  }
  if (request.type === "pp53") {
    if (!request.folioNumber.trim()) {
      throw new PaymentValidationError(["--folio is required for PP53."])
    }
    return
  }

  normalizeDestinationAccount(request.destinationAccount)
  normalizeAmount(request.amount)
  validateLength(request.purposeDescription, "purpose", 70)
  validateLength(request.debitReference, "debit-reference", 24)
  if (request.type === "pp30") {
    validateLength(request.creditReference, "credit-reference", 24)
    return
  }
}

export async function preparePayment(
  request: PaymentRequest,
  options: PrepareOptions = {}
): Promise<PreparedPayment> {
  const today = options.today ?? new Date()
  validatePaymentRequestLocally(request, today)

  const formPath = PAYMENT_PATHS[request.type]
  const session = await (options.openSession ?? openAuthenticatedPath)(formPath)
  const $ = parseForm(session)
  const sourceAccount = findSourceAccount($, request.sourceAccount)
  const payload = basePayload($, request, sourceAccount)

  if (request.type === "pp53") {
    const folioNumber = nonEmpty(request.folioNumber)
    const folio = await resolveFolio(session.client, folioNumber)
    Object.assign(payload, {
      TaxId: requiredFormValue($, "TaxId"),
      FolioNumber: folioNumber,
      Amount: folio.amount,
      NumberOfOrders: folio.numberOfOrders,
    })
    return {
      client: session.client,
      formPath,
      payload,
      summary: {
        amount: folio.amount,
        folioNumber,
        numberOfOrders: folio.numberOfOrders,
        source: sourceAccount,
        type: request.type,
        urgency: request.urgency,
        valueDate: request.valueDate,
      },
      type: request.type,
    }
  }

  const destinationAccount = normalizeDestinationAccount(
    request.destinationAccount
  )
  const amount = normalizeAmount(request.amount)
  if (!payload.OrderingPartyAddress) {
    throw new Error(
      "NLB payment form is missing the required OrderingPartyAddress value."
    )
  }

  if (
    request.urgency &&
    sourceAccount.slice(0, 3) === destinationAccount.slice(0, 3)
  ) {
    throw new PaymentValidationError([
      "--urgent cannot be used when source and destination accounts are at the same bank.",
    ])
  }

  if (request.type === "pp30") {
    const purposeCodes = new Set(
      $("#form_EntryForm select[name='PurposeCode'] option")
        .map((_index, option) => nonEmpty($(option).attr("value")))
        .get()
        .filter(Boolean)
    )
    if (!purposeCodes.has(request.purposeCode)) {
      throw new PaymentValidationError([
        `Purpose code ${request.purposeCode} is not offered by the current NLB form.`,
      ])
    }
  }

  const recipient = await resolveRecipient(
    session.client,
    destinationAccount,
    request.recipientName,
    request.recipientAddress
  )

  Object.assign(payload, {
    PurposeDescription: nonEmpty(request.purposeDescription),
    OrderingPartyReferenceNumber: nonEmpty(request.debitReference),
    OtherPartyName: recipient.recipientName,
    OtherPartyAddress: recipient.recipientAddress,
    DestinationAccount: destinationAccount,
    OtherPartyBank: recipient.bank,
    Amount: amount,
  })

  if (request.type === "pp30") {
    Object.assign(payload, {
      OtherPartyReferenceNumber: nonEmpty(request.creditReference),
      PurposeCode: request.purposeCode,
    })
  } else {
    Object.assign(payload, {
      TaxId: requiredFormValue($, "TaxId"),
      PayeeAccount: nonEmpty(request.payeeAccount),
      BudgetaryAccount: nonEmpty(request.budgetaryAccount),
      IncomeCodeAndProgram: await deriveIncomeCode(session.client, request),
    })
  }

  return {
    client: session.client,
    formPath,
    payload,
    summary: {
      amount,
      destination: destinationAccount,
      recipient: recipient.recipientName,
      source: sourceAccount,
      type: request.type,
      urgency: request.urgency,
      valueDate: request.valueDate,
    },
    type: request.type,
  }
}

function responseText($: CheerioAPI): string {
  const selectors = [
    "#ProcesStatusMessage",
    "#StateStatusMessage",
    ".alert-success",
    ".alert-danger",
    ".validation-summary-errors",
  ]
  for (const selector of selectors) {
    const text = nonEmpty($(selector).first().text())
    if (text) {
      return text.replace(WHITESPACE_PATTERN, " ")
    }
  }
  return ""
}

function validationErrors($: CheerioAPI): string[] {
  const errors = new Set<string>()
  $(
    "[data-valmsg-for], .field-validation-error, .validation-summary-errors li"
  ).each((_index, element) => {
    const text = nonEmpty($(element).text()).replace(WHITESPACE_PATTERN, " ")
    if (text) {
      errors.add(text)
    }
  })
  $(".input-validation-error").each((_index, element) => {
    const name = nonEmpty($(element).attr("name")) || "payment field"
    if (![...errors].some((error) => error.includes(name))) {
      errors.add(`NLB rejected ${name}.`)
    }
  })
  return [...errors]
}

function extractOrderId(html: string): string | undefined {
  for (const pattern of ORDER_ID_PATTERNS) {
    const match = pattern.exec(html)
    if (match?.[1]) {
      return match[1]
    }
  }
  return undefined
}

function classifyStatus(message: string): "approved" | "rejected" | undefined {
  if (APPROVED_STATUS_PATTERN.test(message)) {
    return "approved"
  }
  if (REJECTED_STATUS_PATTERN.test(message)) {
    return "rejected"
  }
  return undefined
}

function extractTaskId(html: string): string | undefined {
  return (
    TASK_CALL_PATTERN.exec(html)?.[1] ?? TASK_ASSIGNMENT_PATTERN.exec(html)?.[1]
  )
}

async function pollAuthorization(
  client: NlbHttpClient,
  taskId: string,
  options: PollOptions
): Promise<{ message: string; status: PaymentStatus }> {
  const timeoutMs = options.timeoutMs ?? 120_000
  const intervalMs = options.intervalMs ?? 5000
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    await sleep(intervalMs)
    const result = await postJson<{
      Completed?: boolean
      TransitionDescription?: string
    }>(client, "/DpsTransferFunds/GetLongRunningTaskStatus", {
      taskid: taskId,
    })
    const message = nonEmpty(result.TransitionDescription)
    if (result.Completed) {
      return {
        message: message || "NLB completed payment authorization.",
        status: classifyStatus(message) ?? "submitted",
      }
    }
  }

  return {
    message:
      "Timed out waiting for mKlik authorization. Verify the order in NLB Klik before retrying.",
    status: "authorization-timeout",
  }
}

export async function submitPreparedPayment(
  prepared: PreparedPayment,
  mode: PaymentMode,
  pollOptions: PollOptions = {}
): Promise<PaymentResult> {
  let response: HttpResponse
  try {
    response = await prepared.client.post(prepared.formPath, {
      ...prepared.payload,
      [mode === "create" ? "4" : "3"]: "",
    })
  } catch (error) {
    throw new AmbiguousPaymentError(
      `NLB Klik did not return a response after the ${mode} submission: ${error instanceof Error ? error.message : String(error)}.`
    )
  }

  if (isLoginRedirect(response)) {
    throw new AmbiguousPaymentError(
      `The session expired during the ${mode} submission.`
    )
  }
  if (response.status < 200 || response.status >= 300) {
    throw new AmbiguousPaymentError(
      `NLB Klik returned HTTP ${response.status} during the ${mode} submission.`
    )
  }

  const html = response.body.toString("utf-8")
  const $ = load(html)
  const errors = validationErrors($)
  if (errors.length > 0) {
    throw new PaymentValidationError(errors)
  }

  const message = responseText($)
  const orderId = extractOrderId(html)
  if (mode === "create") {
    if (!(message || orderId) && $("#form_EntryForm").length > 0) {
      return {
        message:
          "NLB returned the payment form without a confirmation. Do not retry; verify whether a draft was created in NLB Klik.",
        status: "unknown",
        type: prepared.type,
      }
    }
    return {
      message: message || "NLB validated and saved the payment order.",
      orderId,
      status: "draft-created",
      type: prepared.type,
    }
  }

  const taskId = extractTaskId(html)
  if (taskId) {
    const polled = await pollAuthorization(prepared.client, taskId, pollOptions)
    return { ...polled, orderId, type: prepared.type }
  }

  const classified = classifyStatus(message)
  if (classified) {
    return {
      message,
      orderId,
      status: classified,
      type: prepared.type,
    }
  }

  if (AUTHORIZATION_HINT_PATTERN.test(`${message} ${html}`)) {
    return {
      message:
        message ||
        "NLB initiated authorization. Approve it in mKlik and verify the final status in NLB Klik.",
      orderId,
      status: "awaiting-authorization",
      type: prepared.type,
    }
  }

  return {
    message:
      "NLB accepted the sign request but returned an unrecognized status. Do not retry; verify the order in NLB Klik.",
    orderId,
    status: "unknown",
    type: prepared.type,
  }
}

export function defaultValueDate(today = new Date()): string {
  return dateFmt(today)
}

export function paymentSummaryLines(summary: PaymentSummary): string[] {
  return [
    `Type: ${summary.type.toUpperCase()}`,
    `Source: ${summary.source}`,
    ...(summary.destination ? [`Destination: ${summary.destination}`] : []),
    ...(summary.recipient ? [`Recipient: ${summary.recipient}`] : []),
    ...(summary.folioNumber ? [`Folio: ${summary.folioNumber}`] : []),
    ...(summary.numberOfOrders
      ? [`Number of orders: ${summary.numberOfOrders}`]
      : []),
    `Amount: ${summary.amount} MKD`,
    `Value date: ${summary.valueDate}`,
    `Urgent (MIPS): ${summary.urgency ? "yes" : "no"}`,
  ]
}

export async function confirmPaymentInteractively(
  summary: PaymentSummary
): Promise<boolean> {
  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    throw new Error(
      "Sending a payment requires an interactive terminal. No payment was submitted."
    )
  }

  console.log("\nReview payment:")
  for (const line of paymentSummaryLines(summary)) {
    console.log(`  ${line}`)
  }
  const answer = await prompt('Type "SEND" to submit this payment: ')
  return answer === "SEND"
}

export async function executePayment(
  request: PaymentRequest,
  mode: PaymentMode,
  options: ExecutePaymentOptions = {}
): Promise<PaymentResult> {
  const prepared = await preparePayment(request, options)
  if (mode === "send") {
    const confirmed = await (options.confirm ?? confirmPaymentInteractively)(
      prepared.summary
    )
    if (!confirmed) {
      return {
        message: "Payment cancelled. Nothing was submitted.",
        status: "cancelled",
        type: request.type,
      }
    }
  }
  return submitPreparedPayment(prepared, mode, options.poll)
}
