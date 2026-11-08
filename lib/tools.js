/**
 * dsh-account-hub — agent tools.
 *
 * Registers four global tools for agents (including sub-agents):
 *   account_hub_list    list saved accounts and the human-verification state
 *   account_hub_search  search a site through the saved login session
 *   account_hub_fetch   open any URL through the saved login session and read it
 *   account_hub_login   open a visible Edge window so the user can log in / pass a captcha
 *
 * Every tool delegates to the shared accountService; none of them duplicates operation
 * logic. `execute` never throws: failures come back as `{ status: 'error', error }`.
 * Passwords are never part of a tool argument or result.
 */

import { hubError, toErrorPayload } from './accountService.js'

const DEFAULT_LOGIN_MESSAGE =
  'A visible browser window was opened on the user\'s desktop. Ask the user to finish the login or the human verification there, then retry account_hub_search / account_hub_fetch once they confirm. Never ask the user for their password in chat.'

const MANUAL_LOGIN_HINT =
  '该账号为手动登录模式（manual）：插件不会自动填写账号密码，请在打开的浏览器窗口中使用 Google / Apple / passkey / 验证码等方式完成登录，完成后点击“我已完成验证”。'

const LOGIN_MODE_AUTO = 'auto'
const LOGIN_MODE_MANUAL = 'manual'

const TOOL_TIMEOUTS = {
  list: 15_000,
  search: 180_000,
  fetch: 180_000,
  login: 90_000,
}

function defaultLog(...args) {
  console.log('[account-hub]', ...args)
}

/** Accept either `{ log }` or a bare log function (callers pass both forms). */
function normalizeOptions(optionsOrLog) {
  if (typeof optionsOrLog === 'function') return { log: optionsOrLog }
  if (optionsOrLog && typeof optionsOrLog === 'object') return optionsOrLog
  return {}
}

// ---- shared JSON Schema fragments ---------------------------------------

const ACCOUNT_PARAM = {
  type: 'string',
  description: 'Saved account: its id (acc_…) or its label as shown by account_hub_list (case-insensitive).',
}

const MAX_CHARS_PARAM = {
  type: 'integer',
  minimum: 1,
  maximum: 200000,
  description: 'Maximum number of page text characters to return (default 20000).',
}

const LINK_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    url: { type: 'string' },
  },
  additionalProperties: true,
}

const CHALLENGE_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      properties: {
        kind: { type: 'string', description: "'none' | 'captcha' | '2fa' | 'login'" },
        evidence: { type: 'string' },
      },
      additionalProperties: true,
    },
    { type: 'null' },
  ],
}

const PENDING_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      properties: {
        accountId: { type: 'string' },
        label: { type: 'string' },
        url: { type: 'string' },
        phase: { type: 'string', description: "'verification-required' | 'logging-in'" },
        startedAt: { type: 'string' },
        hint: { type: 'string' },
      },
      additionalProperties: true,
    },
    { type: 'null' },
  ],
}

const ERROR_SCHEMA = {
  type: 'object',
  properties: {
    code: { type: 'string' },
    message: { type: 'string' },
  },
  additionalProperties: true,
}

const BROWSER_RESULT_OUTPUT = {
  type: 'object',
  properties: {
    status: { type: 'string', description: "'ok' | 'verification-required' | 'login-required' | 'error'" },
    url: { type: 'string' },
    usedUrl: { type: 'string' },
    guessed: { type: 'boolean', description: 'True when the search URL was guessed instead of configured.' },
    title: { type: 'string' },
    text: { type: 'string', description: 'Readable page text / search results page text.' },
    links: { type: 'array', items: LINK_ITEM_SCHEMA },
    challenge: CHALLENGE_SCHEMA,
    pending: PENDING_SCHEMA,
    hint: { type: 'string' },
    message: { type: 'string' },
    error: ERROR_SCHEMA,
  },
  additionalProperties: true,
}

const LIST_OUTPUT = {
  type: 'object',
  properties: {
    accounts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          url: { type: 'string' },
          username: { type: 'string' },
          loginMode: {
            type: 'string',
            enum: ['auto', 'manual'],
            description:
              "'auto' = the plugin fills the login form; 'manual' = only a window is opened (Google / passkey / multi-step login).",
          },
          sessionStatus: { type: 'string', description: "'unknown' | 'authenticated' | 'expired' | 'verification-required' | 'error'" },
          lastLoginAt: { type: 'string' },
        },
        additionalProperties: true,
      },
    },
    pending: PENDING_SCHEMA,
    browserAvailable: { type: 'boolean' },
    status: { type: 'string' },
    error: ERROR_SCHEMA,
  },
  additionalProperties: true,
}

const LOGIN_OUTPUT = {
  type: 'object',
  properties: {
    status: { type: 'string', description: "'started' | 'busy' | 'error'" },
    loginMode: {
      type: 'string',
      enum: ['auto', 'manual'],
      description: "'auto' = the plugin fills the login form; 'manual' = the user completes the login in the opened window.",
    },
    pending: PENDING_SCHEMA,
    message: { type: 'string' },
    error: ERROR_SCHEMA,
  },
  additionalProperties: true,
}

// ---- helpers -----------------------------------------------------------

function renderJson(_args, value) {
  let text
  try {
    text = JSON.stringify(value ?? null, null, 2)
  } catch {
    text = String(value)
  }
  return [{ type: 'text', text: text ?? 'null' }]
}

function toolError(error) {
  return { status: 'error', error: toErrorPayload(error) }
}

function requireArg(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw hubError('INVALID_INPUT', `参数 ${name} 必须是非空字符串`)
  return value.trim()
}

function maxCharsOptions(value) {
  if (value === undefined || value === null) return undefined
  return { maxChars: value }
}

function sanitizePending(pending) {
  if (!pending || typeof pending !== 'object') return null
  const out = {}
  for (const key of ['accountId', 'label', 'url', 'phase', 'startedAt', 'hint']) {
    if (pending[key] !== undefined) out[key] = pending[key]
  }
  return out
}

function normalizeBrowserResult(result) {
  if (!result || typeof result !== 'object') {
    return { status: 'error', error: { code: 'TOOL_FAILED', message: '浏览器工具没有返回结果' } }
  }
  const out = {}
  for (const key of ['status', 'url', 'usedUrl', 'guessed', 'title', 'text', 'links', 'challenge', 'pending', 'hint', 'message', 'error']) {
    if (result[key] !== undefined) out[key] = result[key]
  }
  if (!out.status) out.status = 'ok'
  if (out.status === 'error' && !out.error) {
    out.error = { code: 'TOOL_FAILED', message: out.message || '浏览器操作失败' }
    out.message = out.message || out.error.message
  }
  if ((out.status === 'verification-required' || out.status === 'login-required') && !out.message && out.hint) {
    out.message = out.hint
  }
  if (out.pending !== undefined) out.pending = sanitizePending(out.pending)
  return out
}

// ---- tool definitions --------------------------------------------------

function createListTool(service) {
  return {
    name: 'account_hub_list',
    description:
      "List the user's saved site accounts (stored encrypted on this machine) together with each account's session status and login mode. " +
      'Use this first to discover which account label or id to pass to account_hub_search, account_hub_fetch or account_hub_login, ' +
      'and to check whether a human-verification step is currently waiting for the user. ' +
      "loginMode 'auto' means the plugin fills the login form; 'manual' means the user completes the login (Google/passkey/2FA) in a window opened by account_hub_login. " +
      'Passwords are never returned.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: { schema: LIST_OUTPUT, render: renderJson },
    timeoutMs: TOOL_TIMEOUTS.list,
    isConcurrencySafe() {
      return true
    },
    async execute() {
      try {
        const state = await service.state()
        const accounts = (Array.isArray(state.accounts) ? state.accounts : []).map((account) => {
          const item = {
            id: String(account.id ?? ''),
            label: String(account.label ?? ''),
            url: String(account.url ?? ''),
            username: String(account.username ?? ''),
            loginMode: account.loginMode === LOGIN_MODE_MANUAL ? LOGIN_MODE_MANUAL : LOGIN_MODE_AUTO,
            sessionStatus: String(account.session?.status ?? 'unknown'),
          }
          if (account.session?.lastLoginAt) item.lastLoginAt = String(account.session.lastLoginAt)
          return item
        })
        return {
          accounts,
          pending: sanitizePending(state.pending),
          browserAvailable: state.browser?.available === true,
        }
      } catch (error) {
        return toolError(error)
      }
    },
  }
}

function createSearchTool(service) {
  return {
    name: 'account_hub_search',
    description:
      "Search inside a website using the user's saved login session, and return the search-results page text and links. " +
      'Use this instead of web_search when the site requires a login, a subscription/paywall, or shows a captcha/human verification that web_search cannot pass — ' +
      'for example searching a journal site the user subscribes to. The site is opened in a browser with the saved session cookies. ' +
      "If the result status is 'verification-required' or 'login-required', call account_hub_login so the user can finish the check in a visible window, then retry.",
    parameters: {
      type: 'object',
      properties: {
        account: ACCOUNT_PARAM,
        query: { type: 'string', description: 'Search keywords to submit on the site.' },
        maxChars: MAX_CHARS_PARAM,
      },
      required: ['account', 'query'],
      additionalProperties: false,
    },
    output: { schema: BROWSER_RESULT_OUTPUT, render: renderJson },
    timeoutMs: TOOL_TIMEOUTS.search,
    isConcurrencySafe() {
      return false
    },
    async execute(args) {
      try {
        const input = args && typeof args === 'object' ? args : {}
        const accountRef = requireArg(input.account, 'account')
        const query = requireArg(input.query, 'query')
        const account = await service.resolveAccount(accountRef)
        const result = await service.search(account.id, query, maxCharsOptions(input.maxChars))
        return normalizeBrowserResult(result)
      } catch (error) {
        return toolError(error)
      }
    },
  }
}

function createFetchTool(service) {
  return {
    name: 'account_hub_fetch',
    description:
      "Open a URL with the user's saved login session and return its readable text and links. " +
      'Use this instead of web_fetch when the page requires a login, a subscription/paywall, or shows a captcha/human verification that web_fetch cannot pass. ' +
      "If the result status is 'verification-required' or 'login-required', call account_hub_login so the user can finish the check in a visible window, then retry.",
    parameters: {
      type: 'object',
      properties: {
        account: ACCOUNT_PARAM,
        url: { type: 'string', description: 'Absolute http(s) URL to open with the saved session.' },
        maxChars: MAX_CHARS_PARAM,
      },
      required: ['account', 'url'],
      additionalProperties: false,
    },
    output: { schema: BROWSER_RESULT_OUTPUT, render: renderJson },
    timeoutMs: TOOL_TIMEOUTS.fetch,
    isConcurrencySafe() {
      return false
    },
    async execute(args) {
      try {
        const input = args && typeof args === 'object' ? args : {}
        const accountRef = requireArg(input.account, 'account')
        const url = requireArg(input.url, 'url')
        const account = await service.resolveAccount(accountRef)
        const result = await service.fetch(account.id, url, maxCharsOptions(input.maxChars))
        return normalizeBrowserResult(result)
      } catch (error) {
        return toolError(error)
      }
    },
  }
}

function createLoginTool(service) {
  return {
    name: 'account_hub_login',
    description:
      'Open a visible browser window on the user\'s desktop for a saved account so the user can log in or complete a captcha / two-factor / human-verification step. ' +
      'Returns immediately: it does not wait for the user. ' +
      "Call it when account_hub_search or account_hub_fetch returned 'verification-required' or 'login-required' (or web_search/web_fetch was blocked by a captcha or paywall). " +
      "The result includes the account's loginMode: 'auto' means the plugin tries to fill the login form, while 'manual' means it never autofills — the user signs in with Google / Apple / a passkey / 2FA by hand. " +
      "Tell the user to finish in the window (mentioning Google/passkey for manual accounts) and retry the search/fetch once they confirm. " +
      'The plugin never solves captchas itself and never needs the user\'s password in chat.',
    parameters: {
      type: 'object',
      properties: {
        account: ACCOUNT_PARAM,
      },
      required: ['account'],
      additionalProperties: false,
    },
    output: { schema: LOGIN_OUTPUT, render: renderJson },
    timeoutMs: TOOL_TIMEOUTS.login,
    isConcurrencySafe() {
      return false
    },
    async execute(args) {
      try {
        const input = args && typeof args === 'object' ? args : {}
        const accountRef = requireArg(input.account, 'account')
        const account = await service.resolveAccount(accountRef)
        const loginMode = account.loginMode === LOGIN_MODE_MANUAL ? LOGIN_MODE_MANUAL : LOGIN_MODE_AUTO
        const result = await service.login(account.id)
        if (!result || result.status === 'error') {
          const payload = result?.error || { code: 'LOGIN_FAILED', message: result?.message || '无法启动登录流程' }
          return { status: 'error', loginMode, error: payload, pending: sanitizePending(result?.pending) }
        }
        let message = result.message || DEFAULT_LOGIN_MESSAGE
        if (loginMode === LOGIN_MODE_MANUAL && !message.includes('手动')) {
          message = `${message} ${MANUAL_LOGIN_HINT}`
        }
        const out = {
          status: result.status,
          loginMode,
          message,
        }
        if (result.pending !== undefined) out.pending = sanitizePending(result.pending)
        return out
      } catch (error) {
        return toolError(error)
      }
    },
  }
}

const TOOL_FACTORIES = [createListTool, createSearchTool, createFetchTool, createLoginTool]

/**
 * Register the account-hub tools on the Host tool registry.
 *
 * @param {object} ctx cordis plugin context
 * @param {object} service accountService instance
 * @param {{log?: (...args:any[])=>void} | ((...args:any[])=>void)} [optionsOrLog]
 * @returns {() => void} idempotent disposer
 */
export function registerTools(ctx, service, optionsOrLog = {}) {
  const { log = defaultLog } = normalizeOptions(optionsOrLog)
  const registry = ctx && typeof ctx.get === 'function' ? ctx.get('tools') || ctx.tools : ctx?.tools
  if (!registry || typeof registry.register !== 'function') {
    console.warn('[account-hub] tools 服务不可用，agent 工具未注册（Settings 页面不受影响）')
    return () => {}
  }
  if (!service || typeof service.resolveAccount !== 'function') {
    console.error('[account-hub] 注册 agent 工具失败：accountService 不可用')
    return () => {}
  }

  const disposers = []
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const disposeTool of disposers.splice(0).reverse()) {
      try {
        disposeTool()
      } catch (error) {
        console.error('[account-hub] 注销 agent 工具失败', error?.message || error)
      }
    }
  }

  const registeredNames = []
  for (const factory of TOOL_FACTORIES) {
    try {
      const definition = factory(service)
      const disposeTool = registry.register(definition)
      if (typeof disposeTool === 'function') disposers.push(disposeTool)
      registeredNames.push(definition.name)
    } catch (error) {
      // Isolate failures: one bad tool must not prevent the others from registering.
      console.error('[account-hub] 注册 agent 工具失败', error?.message || error)
    }
  }

  if (ctx && typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => dispose)
    } catch (error) {
      console.error('[account-hub] 注册工具卸载钩子失败', error?.message || error)
    }
  }
  log(`已注册 ${registeredNames.length} 个 agent 工具：${registeredNames.join(', ')}`)
  return dispose
}

export { TOOL_FACTORIES }
