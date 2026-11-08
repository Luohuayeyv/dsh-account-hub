// lib/browser.js
//
// 浏览器管理器：把 cdp.js 的底层能力组织成“账号会话”语义（对应契约 §7）。
//
//   manager.available()                 同步：浏览器是否可用
//   manager.pending()                   同步：最近一个等待用户操作的 pending（或 null）
//   manager.isBusy(accountId)           同步：该账号是否有进行中的浏览器操作
//   manager.login(accountId)            打开可见窗口 + 自动填表 + 轮询登录/真人验证
//   manager.confirm(accountId)          用户点“我已完成验证”后再次检测并保存会话
//   manager.cancel(accountId)           取消登录/验证，关闭窗口
//   manager.fetch(account, url, opts)   用保存的会话读取页面
//   manager.search(account, query, opts)按 searchUrl 模板（或猜测地址）搜索
//   manager.closeAll()                  关闭所有窗口、清空 pending
//   manager.profilesDir                 每个账号的 profile 根目录
//   manager.removeProfile(accountId)    删除账号时清理其 profile（含 cookie）
//
// 设计要点：
//  - profile 隔离：每个账号独立 user-data-dir = <profilesDir>/<accountId>；
//  - 同一账号串行：pending / 正在 fetch / 正在启动时，新的调用返回相应 pending 或 BUSY；
//  - 真人验证交接：保持可见窗口 + pending + store.setSession('verification-required')，
//    轮询自动检测成功，或用户点“我已完成验证”(confirm) / “取消”(cancel)；
//  - 会话跨浏览器复用：登录成功关闭窗口前，把会话 cookie 转成持久 cookie（否则浏览器退出即丢），
//    下一次 headless fetch 才能复用登录态；
//  - 日志绝不输出密码 / cookie 值。

import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { findBrowserExecutable, launchBrowser } from './cdp.js'
import { readPage } from './extract.js'

const DEFAULT_CONFIG = {
  browserPath: undefined,
  loginTimeoutMs: 600000,
  pageTimeoutMs: 30000,
  maxTextChars: 20000,
  autoOpenOnChallenge: true,
  pollIntervalMs: 2000,
}

// 登录成功后把 session cookie 持久化的有效期（天）。浏览器关闭后 headless 访问仍带登录态。
const SESSION_COOKIE_PERSIST_DAYS = 7
const PAGE_SETTLE_MS = 2000

const LOGOUT_TEXT_PATTERN = /退出|登出|log\s*out|sign\s*out|my account|个人中心/i

// passkey-only / 不支持密码登录 的账号特征（如 GitHub 对 passkey-only 账号返回
// “This account does not support password sign-in, please try another sign-in method...”）。
// 命中这些文本时绝不自动判定登录成功，保持窗口交给用户手动完成。
const PASSKEY_ONLY_TEXT_PATTERN =
  /does not support password sign-in|try another sign-in method|passkey|webauthn|通行密钥/i

// 登录 / session 类似路径：URL 仍停在这些路径时，不允许仅凭“URL 变了/有 cookie”判定成功。
const LOGIN_LIKE_PATH_PATTERN =
  /^\/(?:login|log-in|signin|sign-in|session|sessions|auth|oauth2?|sso|users\/(?:sign_in|login))(?:\/|$)/i

// 登录成功后至少等待多久（与轮询间隔取较大值）才允许自动判定成功。
const MIN_SUCCESS_WAIT_MS = 4000
// 页面无密码框 / 无挑战但一直拿不到成功证据时，连续多少次轮询后转为“请用户确认”。
const NO_EVIDENCE_POLLS_TO_MANUAL = 3

const PASSKEY_ONLY_HINT =
  '该账号不支持密码登录。请在已打开的浏览器窗口中用通行密钥（passkey）/ Google 等方式完成登录' +
  '（可能需要点击“Try another sign-in method”），完成后点击“我已完成验证”。'

const GENERIC_MANUAL_CONFIRM_HINT =
  '无法自动确认登录状态。请在已打开的浏览器窗口中确认已完成登录，然后点击“我已完成验证”。'

// loginMode='manual'（Google / passkey 等无密码账号）：只开窗口，不填表，由用户手动完成。
const MANUAL_LOGIN_HINT =
  '已打开浏览器窗口（不会自动填写账号密码）。请用 Google / Apple / 通行密钥（passkey）/ 短信验证码等' +
  '任意方式手动完成登录，完成后回到账号中心点击“我已完成验证”。'

const LOGIN_LIKE_TEXT_PATTERN = /登录|登入|sign\s*in|log\s*in|login|password|通行密钥|passkey/i

// loginUrl 为空时，按站点 origin 依次探测的常见登录路径（loginUrl 配置了则直接用配置值）。
const LOGIN_PATH_CANDIDATES = ['/login', '/signin', '/sign-in', '/auth/login', '/user/login']
// 自动探测时每个候选路径的导航超时上限（避免 404/慢路径拖垮整个登录流程）。
const LOGIN_DISCOVERY_TIMEOUT_MS = 8000
// 404 / 资源不存在页特征：自动发现登录页时排除。
const NOT_FOUND_TEXT_PATTERN = /404|not found|页面不存在|找不到页面|page not found/i

// —— 登录成功判定（同源门控 + 确定性会话探测）——
// 第三方 OAuth 授权域仅用于 hint/日志；真正的门控是“页面 origin 必须等于账号站点 origin”。
const THIRD_PARTY_LOGIN_HOST_PATTERN =
  /(?:^|\.)(?:accounts\.google\.com|appleid\.apple\.com|login\.microsoftonline\.com|login\.live\.com)$/i
// 确定性探测：响应最终 URL 仍像登录/session 路径。
const LOGIN_PROBE_PATH_PATTERN = /\/(?:login|log-in|signin|sign-in|sessions?|auth)(?:\/|$)/i
// 确定性探测：响应 HTML 的登录页特征。
const PROBE_HTML_PASSWORD_PATTERN = /type\s*=\s*["']?password/i
const PROBE_HTML_TITLE_LOGIN_PATTERN =
  /<title[^>]*>[^<]*(?:登录|登入|sign\s*in|log\s*in|login)[^<]*<\/title>/i
const PROBE_MAX_HTML_CHARS = 200000
// 探测结论中“明确未登录”的失败原因（confirm 时据此返回 still-required）。
const DEFINITIVE_NEGATIVE_PROBE_REASONS = new Set([
  'probe-still-login-url',
  'probe-login-like-final-url',
  'probe-html-password-field',
  'probe-html-login-title',
])

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function nowIso() {
  return new Date().toISOString()
}

function errorMessage(error) {
  if (!error) return '未知错误'
  return error.message ? String(error.message) : String(error)
}

function errorInfo(error) {
  return {
    code: (error && error.code) || 'CDP_ERROR',
    message: errorMessage(error),
  }
}

function urlKey(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || ''))
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '') || '/'}`
  } catch {
    return String(rawUrl || '')
  }
}

/** 页面标题 + 正文（用于 passkey 等文本特征判定；不包含任何凭据）。 */
function pageTextOf(pageInfo) {
  if (!pageInfo) return ''
  return `${pageInfo.title || ''}\n${pageInfo.text || ''}`
}

/** 是否命中 passkey-only / 不支持密码登录 提示。 */
function detectPasskeyOnlyPage(pageInfo) {
  return PASSKEY_ONLY_TEXT_PATTERN.test(pageTextOf(pageInfo))
}

/**
 * 是否确实是“密码登录被拒 / 需要换登录方式”的页面（比 detectPasskeyOnlyPage 更严格）：
 * 必须停在登录/session 类似路径，或正文包含明确的“不支持密码登录 / 换登录方式”措辞。
 * 用于 fetch 与 confirm，避免把普通文章/已登录页面里出现的 passkey 字样误判为登录失败。
 */
function isPasskeyRejectionPage(pageInfo) {
  if (!pageInfo || !detectPasskeyOnlyPage(pageInfo)) return false
  if (isLoginLikeUrl(pageInfo.url)) return true
  return /does not support password sign-in|try another sign-in method/i.test(pageTextOf(pageInfo))
}

/** URL 是否仍停在登录/session 类似路径（非 http(s) 也视为不可判定成功）。 */
function isLoginLikeUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || ''))
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true
    return LOGIN_LIKE_PATH_PATTERN.test(parsed.pathname)
  } catch {
    return true
  }
}

/** 账号站点 origin（优先 account.url，其次 loginUrl；非 http(s) 返回空串）。 */
function siteOriginOf(account) {
  if (!account) return ''
  for (const candidate of [account.url, account.loginUrl]) {
    try {
      const parsed = new URL(String(candidate || ''))
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.origin
    } catch {
      /* continue */
    }
  }
  return ''
}

/** 当前页面是否仍在账号站点 origin 上（第三方 OAuth 域返回 false）。 */
function isSameSiteOrigin(rawUrl, siteOrigin) {
  if (!siteOrigin) return false
  try {
    const parsed = new URL(String(rawUrl || ''))
    return parsed.origin === siteOrigin
  } catch {
    return false
  }
}

function hostOfUrl(rawUrl) {
  try {
    return new URL(String(rawUrl || '')).host
  } catch {
    return ''
  }
}

function pathnameOf(rawUrl) {
  try {
    return new URL(String(rawUrl || '')).pathname
  } catch {
    return ''
  }
}

/** 该 host 是否为已知第三方 OAuth 授权域（仅用于提示文案）。 */
function isKnownThirdPartyLoginHost(rawUrl) {
  const host = hostOfUrl(rawUrl)
  return !!host && THIRD_PARTY_LOGIN_HOST_PATTERN.test(host)
}

/**
 * 解释一条页面内 fetch 探测结果。
 * 返回 { ok:boolean, reason:string, definite?:boolean, finalUrl?, target?, status? }。
 *  - ok=true：满足“最终 URL 已离开登录路径 + 无登录页特征”，或权威 meta 登录标记与页面一致；
 *  - definite=true：探测明确显示仍未登录（仍在登录页/登录页 HTML）；
 *  - 其余为“无法判定”（网络/CORS 失败等），confirm 时按“检测不到”信任用户。
 */
function evaluateProbeResult(item) {
  if (!item || typeof item !== 'object') return { ok: false, reason: 'probe-empty' }
  if (item.error) return { ok: false, reason: 'probe-error', error: String(item.error), target: item.target }
  const finalUrl = String(item.finalUrl || '')
  if (!/^https?:/i.test(finalUrl)) return { ok: false, reason: 'probe-no-final-url', target: item.target }
  const target = String(item.target || '')
  // b) 权威 meta 登录标记：页面与探测响应一致。
  const pageMeta = item.pageMeta || {}
  const probeMeta = item.probeMeta || {}
  for (const key of ['userLogin', 'username']) {
    if (pageMeta[key] && probeMeta[key] && pageMeta[key] === probeMeta[key]) {
      return { ok: true, reason: `auth-meta:${key}`, finalUrl, target, status: item.status }
    }
  }
  // a) 最终 URL 离开登录路径，且响应 HTML 不含登录页特征。
  const targetPath = pathnameOf(target)
  const finalPath = pathnameOf(finalUrl)
  if (finalPath === targetPath || urlKey(finalUrl) === urlKey(target)) {
    return { ok: false, reason: 'probe-still-login-url', finalUrl, target, status: item.status }
  }
  if (LOGIN_PROBE_PATH_PATTERN.test(finalPath)) {
    return { ok: false, reason: 'probe-login-like-final-url', finalUrl, target, status: item.status }
  }
  const html = String(item.html || '')
  if (PROBE_HTML_PASSWORD_PATTERN.test(html)) {
    return { ok: false, reason: 'probe-html-password-field', finalUrl, target, status: item.status }
  }
  if (PROBE_HTML_TITLE_LOGIN_PATTERN.test(html)) {
    return { ok: false, reason: 'probe-html-login-title', finalUrl, target, status: item.status }
  }
  return { ok: true, reason: 'redirect-left-login-path', finalUrl, target, status: item.status }
}

/** 是否 404 / 资源不存在页（自动发现登录页时排除）。 */
function looksLikeNotFoundPage(pageInfo) {
  return NOT_FOUND_TEXT_PATTERN.test(pageTextOf(pageInfo))
}

/**
 * 自动发现登录页时的“像登录页”判定。
 * - 可见密码框 / 验证挑战：强信号，直接认为登录页；
 * - allowTextOnly（候选路径返回的页面）：登录类最终 URL + 登录文案也算，
 *   覆盖 passkey-only / SSO 等没有密码框的登录页；
 * - 404 / 营销页排除。
 */
function looksLikeLoginPageForDiscovery(pageInfo, options = {}) {
  if (!pageInfo) return false
  if (!/^https?:/i.test(pageInfo.url || '')) return false
  if (looksLikeNotFoundPage(pageInfo)) return false
  if (pageInfo.hasPasswordField) return true
  if (pageInfo.challenge && pageInfo.challenge.kind !== 'none') return true
  if (!options.allowTextOnly) return false
  return isLoginLikeUrl(pageInfo.url) && LOGIN_LIKE_TEXT_PATTERN.test(pageTextOf(pageInfo))
}

function hintForChallengeKind(kind) {
  if (kind === 'captcha') {
    return '网站要求真人验证（验证码 / 人机验证）。已打开可见浏览器窗口，请手动完成验证，完成后回到账号中心点击“我已完成验证”。'
  }
  if (kind === '2fa') {
    return '网站要求二次验证（两步验证 / 验证码短信）。已打开可见浏览器窗口，请完成验证，完成后点击“我已完成验证”。'
  }
  return '请在已打开的浏览器窗口中完成登录，完成后点击“我已完成验证”。'
}

function publicPending(pending) {
  if (!pending) return null
  return {
    accountId: pending.accountId,
    label: pending.label,
    url: pending.url,
    phase: pending.phase,
    startedAt: pending.startedAt,
    hint: pending.hint,
  }
}

function sanitizeProfileSegment(accountId) {
  const raw = String(accountId === undefined || accountId === null ? '' : accountId)
  const safe = raw.replace(/[^a-zA-Z0-9._-]/g, '_')
  return safe || 'unknown-account'
}

/**
 * @param {object} options
 * @param {{get:Function, setSession:Function}} options.store store 只需实现 get / setSession
 * @param {string} options.profilesDir 每个账号 profile 的根目录
 * @param {object} [options.config]
 * @param {Function} [options.log]
 */
export function createBrowserManager(options = {}) {
  const store = options.store
  if (!store || typeof store.get !== 'function' || typeof store.setSession !== 'function') {
    throw new Error('createBrowserManager 需要 store（至少实现 get / setSession）。')
  }
  const profilesDir = options.profilesDir || join(tmpdir(), 'dsh-account-hub-profiles')
  const config = { ...DEFAULT_CONFIG, ...(options.config || {}) }
  if (options.log && typeof options.log === 'function') {
    config.log = options.log
  }

  const log = (...args) => {
    if (typeof config.log === 'function') {
      try {
        config.log(...args)
      } catch {
        /* 日志失败不影响主流程 */
      }
    }
  }

  /** accountId -> 等待用户操作的 pending（含内部引用） */
  const pendings = new Map()
  /** accountId -> { browser, page } 可见窗口 */
  const activeWindows = new Map()
  /** accountId -> 正在 headless 读取的标记 */
  const fetchInFlight = new Set()
  /** accountId -> 正在启动可见窗口的标记 */
  const startingWindows = new Set()
  /** 所有存活的浏览器实例（用于 closeAll / 残留诊断） */
  const liveBrowsers = new Set()
  /** 本次管理器生命周期内启动过的浏览器 pid（诊断/测试用） */
  const launchedBrowserPids = []

  let availabilityCache = null

  function available() {
    if (!availabilityCache) {
      try {
        const executablePath = findBrowserExecutable(config.browserPath)
        availabilityCache = { browserAvailable: true, executablePath }
      } catch (error) {
        availabilityCache = { browserAvailable: false, error: errorMessage(error) }
      }
    }
    return { ...availabilityCache }
  }

  function pending() {
    let latest = null
    for (const item of pendings.values()) {
      if (!latest || String(item.startedAt) > String(latest.startedAt)) latest = item
    }
    return publicPending(latest)
  }

  function pendingFor(accountId) {
    return publicPending(pendings.get(accountId) || null)
  }

  function pendingList() {
    return [...pendings.values()].map(publicPending)
  }

  function pendingCount() {
    return pendings.size
  }

  function isBusy(accountId) {
    return (
      pendings.has(accountId) ||
      activeWindows.has(accountId) ||
      fetchInFlight.has(accountId) ||
      startingWindows.has(accountId)
    )
  }

  function profileDirFor(accountOrId) {
    const id = typeof accountOrId === 'string' ? accountOrId : accountOrId && accountOrId.id
    return join(profilesDir, sanitizeProfileSegment(id))
  }

  function trackBrowser(browser, headed) {
    browser.headed = !!headed
    if (browser.pid) launchedBrowserPids.push(browser.pid)
    liveBrowsers.add(browser)
    return browser
  }

  async function closeBrowser(browser) {
    if (!browser) return
    liveBrowsers.delete(browser)
    try {
      await browser.close()
    } catch (error) {
      log('关闭浏览器时出错', errorMessage(error))
    }
  }

  async function safeSetSession(accountId, patch) {
    try {
      const result = await store.setSession(accountId, patch)
      return result
    } catch (error) {
      log('写入会话状态失败', accountId, errorMessage(error))
      return undefined
    }
  }

  async function getAccount(accountId) {
    try {
      return await store.get(accountId)
    } catch (error) {
      log('读取账号失败', accountId, errorMessage(error))
      return undefined
    }
  }

  // ---------------------------------------------------------------------------
  // 自动填表（原生 setter + input/change 事件 + 点击提交 / requestSubmit）
  // ---------------------------------------------------------------------------

  async function fillLoginForm(page, account) {
    const username = typeof account.username === 'string' ? account.username : ''
    const password = typeof account.password === 'string' ? account.password : ''
    const filled = await page.evaluate(
      (credentials) => {
        function isVisible(element) {
          try {
            if (!element || !element.isConnected) return false
            if (element.closest('[hidden]')) return false
            const style = window.getComputedStyle(element)
            if (!style) return false
            if (
              style.display === 'none' ||
              style.visibility === 'hidden' ||
              style.visibility === 'collapse'
            ) {
              return false
            }
            const rect = element.getBoundingClientRect()
            if (rect.width < 1 || rect.height < 1) return false
            return true
          } catch {
            return false
          }
        }
        function setNativeValue(element, value) {
          try {
            const proto = window.HTMLInputElement.prototype
            const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
            if (descriptor && typeof descriptor.set === 'function') descriptor.set.call(element, value)
            else element.value = value
          } catch {
            element.value = value
          }
          element.dispatchEvent(new Event('input', { bubbles: true }))
          element.dispatchEvent(new Event('change', { bubbles: true }))
          element.dispatchEvent(new Event('blur', { bubbles: false }))
        }
        const userSelectors = [
          'input[type="email"]',
          'input[autocomplete*="username" i]',
          'input[name*="user" i]',
          'input[name*="email" i]',
          'input[id*="user" i]',
          'input[type="text"]',
        ]
        let userField = null
        outer: for (const selector of userSelectors) {
          let nodes = []
          try {
            nodes = document.querySelectorAll(selector)
          } catch {
            continue
          }
          for (const node of nodes) {
            if (!isVisible(node)) continue
            if (node.disabled || node.readOnly) continue
            const type = String(node.getAttribute('type') || 'text').toLowerCase()
            if (type === 'password' || type === 'hidden') continue
            userField = node
            break outer
          }
        }
        let passwordField = null
        try {
          for (const node of document.querySelectorAll('input[type="password"]')) {
            if (isVisible(node) && !node.disabled) {
              passwordField = node
              break
            }
          }
        } catch {
          /* ignore */
        }
        let filledUsername = false
        let filledPassword = false
        if (userField && credentials.username) {
          try {
            userField.focus()
          } catch {
            /* ignore */
          }
          setNativeValue(userField, credentials.username)
          filledUsername = userField.value === credentials.username
        }
        if (passwordField && credentials.password) {
          try {
            passwordField.focus()
          } catch {
            /* ignore */
          }
          setNativeValue(passwordField, credentials.password)
          filledPassword = passwordField.value === credentials.password
        }
        const submitButtons = [
          ...document.querySelectorAll('button[type="submit"], input[type="submit"], form button, button'),
        ]
        let submit = null
        for (const button of submitButtons) {
          if (!isVisible(button)) continue
          let text = ''
          try {
            text = String(button.innerText || button.value || '').trim()
          } catch {
            /* ignore */
          }
          if (/登录|登入|sign\s*in|log\s*in|login|submit|continue|next|继续/i.test(text)) {
            submit = button
            break
          }
        }
        if (!submit) {
          for (const button of submitButtons) {
            if (isVisible(button)) {
              submit = button
              break
            }
          }
        }
        if (submit) submit.setAttribute('data-dsh-ah-submit', '1')
        const form = passwordField ? passwordField.form : userField ? userField.form : null
        if (form) form.setAttribute('data-dsh-ah-form', '1')
        return {
          username: filledUsername,
          password: filledPassword,
          submitFound: !!submit,
          formFound: !!form,
        }
      },
      { username, password },
    )

    // 点击/提交放在单独一次 evaluate 里：表单提交会触发导航，执行上下文可能被销毁，视为已提交。
    let submitMethod = 'none'
    try {
      submitMethod = await page.evaluate(() => {
        const button = document.querySelector('[data-dsh-ah-submit="1"]')
        if (button) {
          button.click()
          return 'click'
        }
        const form = document.querySelector('[data-dsh-ah-form="1"]')
        if (form && typeof form.requestSubmit === 'function') {
          form.requestSubmit()
          return 'requestSubmit'
        }
        return 'none'
      })
    } catch (error) {
      // 如果点击按钮后页面开始跳转，Runtime.evaluate 可能因 context destroyed 而失败。
      if (error && /context|destroyed|navigat/i.test(errorMessage(error))) submitMethod = 'click'
    }
    return {
      ...(filled || {}),
      submitMethod,
      submitted: submitMethod === 'click' || submitMethod === 'requestSubmit',
    }
  }

  // ---------------------------------------------------------------------------
  // 登录成功判定（同源门控 + 确定性会话探测）
  //
  // 教训（task-5 / task-10）：
  //  - passkey-only 账号被密码登录拒绝后 GitHub 返回 /session，旧逻辑把“无密码框 + 有 cookie”误判成功；
  //  - manual 登录点「Continue with Google」跳到 accounts.google.com，旧逻辑把“第三方页 URL 变了”
  //    误判成功并关窗，实际站点未登录。
  // 因此现在自动判定成功必须同时满足：
  //   1. 当前页面无可见密码框、无 captcha/2FA 挑战、无 passkey/不支持密码登录提示；
  //   2. 当前页面 origin === 账号站点 origin（第三方 OAuth 域一律视为进行中，绝不判成功、绝不关窗）；
  //   3. 连续至少 2 次轮询满足 1+2，且距登录开始至少 max(1 个轮询周期, 4s)；
  //   4. 页面内 fetch(loginUrl || account.url / 自动发现的登录页) 的确定性探测通过：
  //      a. 最终 URL 已离开登录路径，且响应 HTML 无登录页特征（密码框 / 登录标题）；或
  //      b. 权威 meta[name=user-login|name=username] 与探测响应一致。
  // 拿不到确定性证据 ≥3 轮 → 转 verification-required 交用户确认；宁可多让用户确认，绝不误判。
  // ---------------------------------------------------------------------------

  /**
   * 确定性会话探测：在账号站点页面内 fetch 登录页（credentials include / redirect follow），
   * 按 evaluateProbeResult 解释。返回 { ok, reason, definite?, finalUrl?, target? }。
   */
  async function probeSessionDeterministic(pending) {
    const { account } = pending
    if (!pending.page || pending.page.closed || !pending.browser || pending.browser.closed) {
      return { ok: false, reason: 'probe-no-page' }
    }
    const configuredLoginUrl =
      typeof account.loginUrl === 'string' && account.loginUrl.trim() ? account.loginUrl.trim() : ''
    const targets = []
    for (const candidate of [pending.loginProbeUrl, configuredLoginUrl, account.url]) {
      if (!candidate || !/^https?:\/\//i.test(candidate)) continue
      if (!targets.includes(candidate)) targets.push(candidate)
    }
    if (targets.length === 0) return { ok: false, reason: 'probe-no-target' }
    let rawResults = null
    try {
      rawResults = await pending.page.evaluate(
        async (params) => {
          function readMeta(doc, name) {
            try {
              const element = doc.querySelector(`meta[name="${name}"]`)
              return element ? String(element.getAttribute('content') || '') : ''
            } catch {
              return ''
            }
          }
          const results = []
          for (const target of params.targets) {
            try {
              const response = await fetch(target, { credentials: 'include', redirect: 'follow' })
              let html = ''
              try {
                html = await response.text()
              } catch {
                html = ''
              }
              let probeMeta = { userLogin: '', username: '' }
              try {
                const doc = new DOMParser().parseFromString(html, 'text/html')
                probeMeta = { userLogin: readMeta(doc, 'user-login'), username: readMeta(doc, 'username') }
              } catch {
                /* ignore */
              }
              results.push({
                target,
                ok: !!response.ok,
                status: Number(response.status) || 0,
                finalUrl: String(response.url || ''),
                html: html.slice(0, params.maxHtmlChars),
                pageMeta: {
                  userLogin: readMeta(document, 'user-login'),
                  username: readMeta(document, 'username'),
                },
                probeMeta,
              })
            } catch (error) {
              results.push({
                target,
                error: String(error && error.message ? error.message : error),
              })
            }
          }
          return results
        },
        { targets, maxHtmlChars: PROBE_MAX_HTML_CHARS },
      )
    } catch (error) {
      return { ok: false, reason: 'probe-eval-failed', error: errorMessage(error) }
    }
    const evaluated = (Array.isArray(rawResults) ? rawResults : []).map(evaluateProbeResult)
    const positive = evaluated.find((result) => result.ok)
    if (positive) return positive
    const definite = evaluated.find((result) => DEFINITIVE_NEGATIVE_PROBE_REASONS.has(result.reason))
    if (definite) return { ...definite, ok: false, definite: true }
    return {
      ok: false,
      reason: (evaluated[0] && evaluated[0].reason) || 'probe-indeterminate',
      error: evaluated[0] && evaluated[0].error,
    }
  }

  // ---------------------------------------------------------------------------
  // 登录成功前把 session cookie 持久化（浏览器关闭后 headless 仍可复用登录态）
  // ---------------------------------------------------------------------------

  async function persistSessionCookies(pending) {
    if (!pending || !pending.page || pending.page.closed || !pending.browser) return 0
    try {
      const cookies = await pending.browser.cookies()
      const sessionCookies = cookies.filter(
        (cookie) => cookie.session === true || typeof cookie.expires !== 'number' || cookie.expires <= 0,
      )
      if (!sessionCookies.length) return 0
      const expires = Math.floor(Date.now() / 1000) + SESSION_COOKIE_PERSIST_DAYS * 24 * 3600
      let persisted = 0
      for (const cookie of sessionCookies) {
        try {
          const domain = String(cookie.domain || '').replace(/^\./, '')
          if (!domain) continue
          const path = cookie.path || '/'
          const url = `${cookie.secure ? 'https' : 'http'}://${domain}${path}`
          const params = {
            name: cookie.name,
            value: cookie.value,
            url,
            domain: cookie.domain,
            path,
            secure: !!cookie.secure,
            httpOnly: !!cookie.httpOnly,
            expires,
          }
          if (cookie.sameSite) params.sameSite = cookie.sameSite
          await pending.page.send('Network.setCookie', params, { timeoutMs: 5000 })
          persisted += 1
        } catch {
          /* 单个 cookie 失败不影响其它 */
        }
      }
      if (persisted > 0) log('已将会话 cookie 转为持久 cookie', persisted, '个')
      return persisted
    } catch (error) {
      log('持久化会话 cookie 失败（忽略）', errorMessage(error))
      return 0
    }
  }

  // ---------------------------------------------------------------------------
  // pending 生命周期
  // ---------------------------------------------------------------------------

  async function finalizePending(pending, reason, detailOverride) {
    if (!pending || pending.settled) return
    pending.settled = true
    const accountId = pending.accountId
    // 1) 先持久化会话 cookie（需要页面还在），2) 再真正关闭浏览器进程。
    //    顺序很重要：浏览器关闭后同一 profile 才能被下一次 fetch/login 复用，
    //    避免外部一看到 authenticated/pending 变化就启动新浏览器导致“profile 正在使用”竞态。
    try {
      if (reason === 'success') {
        await persistSessionCookies(pending)
      }
    } finally {
      await closeBrowser(pending.browser)
    }
    // 3) 窗口已关闭后再写会话状态；4) 最后才移除 pending。
    //    这样外部用 pending() === null / pendingFor() === null 判断“流程完全结束”是可靠的。
    try {
      if (reason === 'success') {
        await safeSetSession(accountId, {
          status: 'authenticated',
          lastLoginAt: nowIso(),
          lastCheckedAt: nowIso(),
          detail: '',
        })
      } else if (reason === 'timeout') {
        await safeSetSession(accountId, {
          status: 'error',
          lastCheckedAt: nowIso(),
          detail: detailOverride || '登录或真人验证等待超时，已关闭浏览器窗口。',
        })
      } else if (reason === 'error') {
        await safeSetSession(accountId, {
          status: 'error',
          lastCheckedAt: nowIso(),
          detail: detailOverride || '登录过程出错，已关闭浏览器窗口。',
        })
      } else if (reason === 'browser-closed') {
        await safeSetSession(accountId, {
          status: 'unknown',
          lastCheckedAt: nowIso(),
          detail: detailOverride || '浏览器窗口已被关闭，未能确认登录状态。',
        })
      } else if (reason === 'cancelled') {
        await safeSetSession(accountId, {
          status: 'unknown',
          lastCheckedAt: nowIso(),
          detail: detailOverride || '已取消登录/验证。',
        })
      }
    } finally {
      if (pendings.get(accountId) === pending) pendings.delete(accountId)
      const active = activeWindows.get(accountId)
      if (active && active.browser === pending.browser) activeWindows.delete(accountId)
    }
    log('交互式浏览器流程结束', accountId, reason)
  }

  // ---------------------------------------------------------------------------
  // 登录/验证轮询
  // ---------------------------------------------------------------------------

  async function monitorPending(pending) {
    const { account } = pending
    const loginUrl = account.loginUrl || account.url
    const startedMs = Date.parse(pending.startedAt) || Date.now()
    const pollMs = Math.max(250, Number(config.pollIntervalMs) || 2000)
    const loginTimeoutMs = Math.max(10000, Number(config.loginTimeoutMs) || 600000)
    // 首次成功判定前至少等待 max(1 个轮询周期, 4s)。
    const minSuccessWaitMs = Math.max(pollMs, MIN_SUCCESS_WAIT_MS)
    let passwordSeenPolls = 0
    let readErrors = 0
    // 连续“无密码框 + 无挑战 + 非 passkey 页”的轮询次数。
    let successStreak = 0
    // 到达最短等待后仍拿不到成功证据的轮询次数（累计到阈值转人工确认）。
    let noEvidencePolls = 0

    for (;;) {
      if (pending.settled) return
      if (pending.cancel) {
        await finalizePending(pending, 'cancelled')
        return
      }
      if (Date.now() - startedMs > loginTimeoutMs) {
        await finalizePending(pending, 'timeout')
        return
      }
      if (pending.confirming) {
        await sleep(300)
        continue
      }

      let pageInfo = null
      try {
        pageInfo = await readPage(pending.page, { maxChars: 6000, maxLinks: 0 })
        readErrors = 0
      } catch (error) {
        readErrors += 1
        const browserGone =
          pending.browser.closed ||
          pending.page.closed ||
          (error && /已关闭|closed|disconnect|target/i.test(errorMessage(error)))
        if (browserGone) {
          log('登录流程：浏览器窗口被关闭', pending.accountId)
          await finalizePending(pending, 'browser-closed')
          return
        }
        if (readErrors >= 5) {
          await finalizePending(pending, 'error', `读取登录页面失败：${errorMessage(error)}`)
          return
        }
        await sleep(pollMs)
        continue
      }

      // 读取期间用户可能已 cancel / closeAll / confirm，先检查再继续写状态。
      if (pending.settled || pending.cancel) return

      const passkeyOnly = detectPasskeyOnlyPage(pageInfo)
      const challengeKind =
        pageInfo.challenge && pageInfo.challenge.kind !== 'none' ? pageInfo.challenge.kind : null

      if (passkeyOnly) {
        // 账号不支持密码登录（passkey-only 等）：绝不判成功，保持窗口 + pending。
        successStreak = 0
        noEvidencePolls = 0
        passwordSeenPolls = 0
        pending.phase = 'verification-required'
        pending.challengeKind = 'login'
        // manual 模式本来就提示手动登录，保留更完整的手动指引。
        pending.hint = pending.loginMode === 'manual' ? MANUAL_LOGIN_HINT : PASSKEY_ONLY_HINT
        pending.url = pageInfo.url || pending.url
        await safeSetSession(pending.accountId, {
          status: 'verification-required',
          lastCheckedAt: nowIso(),
          detail: pending.hint,
        })
      } else if (challengeKind) {
        successStreak = 0
        noEvidencePolls = 0
        passwordSeenPolls = 0
        pending.phase = 'verification-required'
        pending.challengeKind = challengeKind
        pending.hint = hintForChallengeKind(challengeKind)
        pending.url = pageInfo.url || pending.url
        await safeSetSession(pending.accountId, {
          status: 'verification-required',
          lastCheckedAt: nowIso(),
          detail: pending.hint,
        })
      } else if (pageInfo.hasPasswordField) {
        successStreak = 0
        noEvidencePolls = 0
        passwordSeenPolls += 1
        const elapsed = Date.now() - startedMs
        if (passwordSeenPolls >= 2 || elapsed > 8000) {
          pending.phase = 'verification-required'
          pending.hint =
            pending.loginMode === 'manual'
              ? MANUAL_LOGIN_HINT
              : '自动登录未成功。请在已打开的浏览器窗口中手动完成登录（或完成验证），完成后点击“我已完成验证”。'
          await safeSetSession(pending.accountId, {
            status: 'verification-required',
            lastCheckedAt: nowIso(),
            detail: pending.hint,
          })
        } else {
          pending.hint = '正在等待登录完成…'
        }
        pending.url = pageInfo.url || pending.url
      } else {
        // 候选成功页（无密码框 / 无挑战 / 非 passkey 页）。
        // 先做同源门控：第三方 OAuth 域（accounts.google.com 等）一律视为“进行中”，绝不判定成功。
        const siteOrigin = pending.siteOrigin || siteOriginOf(account)
        pending.siteOrigin = siteOrigin
        const currentUrl = pageInfo.url || ''
        if (!isSameSiteOrigin(currentUrl, siteOrigin)) {
          successStreak = 0
          noEvidencePolls = 0
          pending.phase = 'verification-required'
          pending.challengeKind = null
          pending.url = currentUrl || pending.url
          const host = hostOfUrl(currentUrl) || '第三方站点'
          pending.hint =
            pending.loginMode === 'manual'
              ? MANUAL_LOGIN_HINT
              : `正在第三方登录页（${host}）完成授权，请完成授权并等待自动跳回账号站点；完成后也可点击“我已完成验证”。`
          if (isKnownThirdPartyLoginHost(currentUrl)) log('登录流程处于第三方 OAuth 授权页', pending.accountId, host)
          await safeSetSession(pending.accountId, {
            status: 'verification-required',
            lastCheckedAt: nowIso(),
            detail: pending.hint,
          })
        } else {
          successStreak += 1
          passwordSeenPolls = 0
          pending.url = currentUrl || pending.url
          const elapsed = Date.now() - startedMs
          let probe = null
          if (successStreak >= 2 && elapsed >= minSuccessWaitMs) {
            probe = await probeSessionDeterministic(pending)
          }
          if (probe && probe.ok) {
            log('登录成功判定通过（同源 + 确定性探测）', pending.accountId, probe.reason)
            await finalizePending(pending, 'success')
            return
          }
          if (probe && !probe.ok) {
            log('会话确定性探测未通过（继续等待/转人工确认）', pending.accountId, probe.reason)
          }
          if (elapsed >= minSuccessWaitMs) {
            noEvidencePolls += 1
            if (noEvidencePolls >= NO_EVIDENCE_POLLS_TO_MANUAL) {
              // 同源页面但确定性探测拿不到“已登录”证据：宁可交给用户确认。
              pending.phase = 'verification-required'
              pending.challengeKind = null
              pending.hint =
                pending.loginMode === 'manual' ? MANUAL_LOGIN_HINT : GENERIC_MANUAL_CONFIRM_HINT
              await safeSetSession(pending.accountId, {
                status: 'verification-required',
                lastCheckedAt: nowIso(),
                detail: pending.hint,
              })
            } else if (pending.phase === 'logging-in') {
              pending.hint = '正在等待登录完成…'
            }
          }
        }
      }

      await sleep(pollMs)
    }
  }

  // ---------------------------------------------------------------------------
  // 可见窗口启动
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // 登录页自动发现（账号 loginUrl 为空时）
  //
  // 真实场景：GitHub 未登录时 https://github.com/ 是营销首页，真正的登录页在 /login。
  // 打开 url 后若当前页不像登录页，就按 origin 依次探测常见登录路径，选第一个确实像
  // 登录页（有密码框/验证挑战，或登录类路径+登录文案）的 URL；都不像则回退到 url。
  // 每个候选路径最多 ~8s，404/超时/异常都忽略，绝不拖垮登录流程。
  // ---------------------------------------------------------------------------

  async function discoverLoginPage(pending) {
    const { account } = pending
    const originalUrl = pending.url
    const navTimeoutMs = Math.min(
      LOGIN_DISCOVERY_TIMEOUT_MS,
      Math.max(5000, Number(config.pageTimeoutMs) || 30000),
    )
    // 1) 当前页已经是登录页？
    try {
      const current = await readPage(pending.page, { maxChars: 3000, maxLinks: 0 })
      if (looksLikeLoginPageForDiscovery(current, { allowTextOnly: false })) {
        return { url: current.url || originalUrl, reason: 'current-page' }
      }
    } catch (error) {
      log('登录页探测：读取当前页失败（继续探测）', errorMessage(error))
    }
    // 2) 依次探测候选路径。
    let origin = ''
    try {
      origin = new URL(account.url).origin
    } catch {
      return null
    }
    for (const path of LOGIN_PATH_CANDIDATES) {
      if (pending.settled || pending.cancel) return null
      const candidateUrl = `${origin}${path}`
      try {
        const nav = await pending.page.goto(candidateUrl, { timeoutMs: navTimeoutMs })
        await sleep(400)
        const info = await readPage(pending.page, { maxChars: 3000, maxLinks: 0 })
        const finalUrl = (nav && nav.url) || info.url || candidateUrl
        if (looksLikeLoginPageForDiscovery({ ...info, url: finalUrl }, { allowTextOnly: true })) {
          return { url: finalUrl, reason: `candidate:${path}` }
        }
      } catch (error) {
        log('登录页探测：候选路径失败（忽略）', path, errorMessage(error))
      }
    }
    // 3) 都不像：回到用户配置的 url，避免把用户留在中途的 404/无关页面。
    if (originalUrl) {
      try {
        await pending.page.goto(originalUrl, { timeoutMs: navTimeoutMs })
      } catch (error) {
        log('登录页探测：回退原页面失败（保持当前页）', errorMessage(error))
      }
    }
    return null
  }

  /**
   * 启动浏览器（带重试）：上一个窗口关闭后立刻启动可能遇到 profile 短暂被占用
   * （Chromium 以 exit code 21 / PROFILE_IN_USE 退出），重试几次即可恢复。
   */
  async function launchBrowserWithRetry(options, attempts = 3) {
    let lastError = null
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await launchBrowser(options)
      } catch (error) {
        lastError = error
        const message = errorMessage(error)
        const transient =
          /启动过程中退出|exit code 21|profile|占用|正在关闭/i.test(message) &&
          !/不存在|NO_BROWSER/i.test(message)
        if (!transient || attempt >= attempts) throw error
        log('浏览器启动遇到瞬时的 profile 占用，重试', attempt, message)
        await sleep(500 * attempt)
      }
    }
    throw lastError
  }

  async function openVisibleWindow(account, url, options = {}) {
    const availability = available()
    if (!availability.browserAvailable) {
      return { status: 'error', error: { code: 'NO_BROWSER', message: availability.error || '未找到可用的浏览器。' } }
    }
    const profileDir = profileDirFor(account)
    let browser = null
    try {
      await mkdir(profileDir, { recursive: true })
      browser = trackBrowser(
        await launchBrowserWithRetry({
          headed: true,
          profileDir,
          executablePath: availability.executablePath,
          timeoutMs: Math.max(25000, Number(config.pageTimeoutMs) || 30000),
        }),
        true,
      )
      const page = await browser.newPage()
      const pending = {
        accountId: account.id,
        label: account.label || account.username || '',
        url: url || account.url,
        phase: options.phase || 'verification-required',
        startedAt: nowIso(),
        hint: options.hint || '请在弹出的浏览器窗口中完成操作。',
        challengeKind: options.challengeKind || null,
        loginMode: account.loginMode === 'manual' ? 'manual' : 'auto',
        siteOrigin: siteOriginOf(account),
        loginProbeUrl:
          (typeof account.loginUrl === 'string' && account.loginUrl.trim()) || account.url || '',
        account,
        browser,
        page,
        cancel: false,
        settled: false,
        confirming: false,
      }
      pendings.set(account.id, pending)
      activeWindows.set(account.id, { browser, page })
      // 后台加载页面 -> 自动填表（如适用）-> 轮询检测
      runInteractiveWindow(pending, {
        fill: options.fill !== false,
        autoFill: options.autoFill === true,
      }).catch((error) => {
        log('可见窗口后台流程异常', account.id, errorMessage(error))
      })
      return { status: 'started', pending: publicPending(pending) }
    } catch (error) {
      if (browser) await closeBrowser(browser)
      return { status: 'error', error: errorInfo(error) }
    }
  }

  async function runInteractiveWindow(pending, options) {
    const { account } = pending
    try {
      await pending.page.goto(pending.url, {
        timeoutMs: Math.max(5000, Number(config.pageTimeoutMs) || 30000),
      })
    } catch (error) {
      log('可见窗口加载页面失败（保持窗口打开）', errorMessage(error))
      pending.hint = `页面加载失败：${errorMessage(error)}。请在窗口中手动打开 ${pending.url} 后操作。`
    }
    if (pending.settled || pending.cancel) return
    // loginUrl 为空：自动发现真正的登录页（auto 与 manual 都适用）。
    if (pending.discoverLoginUrl) {
      try {
        const discovered = await discoverLoginPage(pending)
        if (discovered && discovered.url) {
          // 只记录 URL / 判定来源，不含任何凭据。
          log('已自动发现登录页', discovered.url, discovered.reason)
          pending.url = discovered.url
          // 确定性探测以“真正打开过的登录页”为准（loginUrl 为空时 account.url 是营销首页，无法判断）。
          pending.loginProbeUrl = discovered.url
        } else {
          log('登录页探测未命中，继续使用账号 URL', pending.url)
        }
      } catch (error) {
        log('登录页自动探测失败（继续使用原地址）', errorMessage(error))
      }
    }
    if (pending.settled || pending.cancel) return
    await sleep(options.autoFill ? Math.min(2500, PAGE_SETTLE_MS + 500) : PAGE_SETTLE_MS)
    if (pending.settled || pending.cancel) return
    if (options.fill) {
      try {
        const result = await fillLoginForm(pending.page, account)
        if (result && result.submitted) {
          pending.hint = '已自动填写并提交登录，正在等待登录完成…'
        } else if (result && (result.username || result.password)) {
          pending.hint = '已自动填写账号密码，请在窗口中完成登录（如有验证码请手动完成）…'
        }
      } catch (error) {
        log('自动填表失败（继续轮询，可手动输入）', errorMessage(error))
      }
    }
    await monitorPending(pending)
  }

  // ---------------------------------------------------------------------------
  // 公开 API
  // ---------------------------------------------------------------------------

  async function login(accountId) {
    if (isBusy(accountId)) {
      const existing = pendings.get(accountId)
      return {
        status: 'busy',
        hint: existing ? existing.hint : '该账号正在执行其他浏览器操作，请稍候。',
        ...(existing ? { pending: publicPending(existing) } : {}),
      }
    }
    const availability = available()
    if (!availability.browserAvailable) {
      return { status: 'error', error: { code: 'NO_BROWSER', message: availability.error || '未找到可用的浏览器。' } }
    }
    const account = await getAccount(accountId)
    if (!account) {
      return { status: 'error', error: { code: 'NOT_FOUND', message: '账号不存在。' } }
    }
    // loginMode='manual'：Google / passkey 等无密码账号，只开窗口不填表（避免必然失败的自动填表）。
    const loginMode = account.loginMode === 'manual' ? 'manual' : 'auto'
    startingWindows.add(accountId)
    let browser = null
    try {
      const profileDir = profileDirFor(account)
      await mkdir(profileDir, { recursive: true })
      browser = trackBrowser(
        await launchBrowserWithRetry({
          headed: true,
          profileDir,
          executablePath: availability.executablePath,
          timeoutMs: Math.max(25000, Number(config.pageTimeoutMs) || 30000),
        }),
        true,
      )
      const page = await browser.newPage()
      // loginUrl 为空时先打开 account.url，随后自动探测常见登录路径（/login、/signin…）。
      const configuredLoginUrl =
        typeof account.loginUrl === 'string' && account.loginUrl.trim() ? account.loginUrl.trim() : ''
      const loginUrl = configuredLoginUrl || account.url
      const pending = {
        accountId: account.id,
        label: account.label || account.username || '',
        url: loginUrl,
        phase: loginMode === 'manual' ? 'verification-required' : 'logging-in',
        startedAt: nowIso(),
        hint: loginMode === 'manual' ? MANUAL_LOGIN_HINT : '已打开浏览器窗口，正在自动填写账号密码…',
        loginMode,
        discoverLoginUrl: !configuredLoginUrl,
        siteOrigin: siteOriginOf(account),
        loginProbeUrl: configuredLoginUrl || account.url,
        challengeKind: null,
        account,
        browser,
        page,
        cancel: false,
        settled: false,
        confirming: false,
      }
      pendings.set(accountId, pending)
      activeWindows.set(accountId, { browser, page })
      startingWindows.delete(accountId)
      // manual：不填表、不提交，只轮询检测用户是否已手动完成。
      runInteractiveWindow(pending, { fill: loginMode !== 'manual', autoFill: false }).catch((error) => {
        log('登录流程后台异常', accountId, errorMessage(error))
      })
      return { status: 'started', hint: pending.hint, pending: publicPending(pending), loginMode }
    } catch (error) {
      startingWindows.delete(accountId)
      if (browser) await closeBrowser(browser)
      await safeSetSession(accountId, {
        status: 'error',
        lastCheckedAt: nowIso(),
        detail: `打开登录窗口失败：${errorMessage(error)}`,
      })
      return { status: 'error', error: errorInfo(error) }
    }
  }

  async function confirm(accountId) {
    const pending = pendings.get(accountId)
    if (!pending) {
      const account = await getAccount(accountId)
      if (account && account.session && account.session.status === 'authenticated') {
        return { status: 'authenticated', detail: '该账号当前已是登录状态。' }
      }
      return { status: 'error', detail: '当前没有等待真人验证的登录流程。' }
    }
    if (pending.settled) {
      return { status: 'error', detail: '登录流程已结束。' }
    }
    if (pending.confirming) {
      return { status: 'still-required', detail: '正在检测页面状态，请稍候…' }
    }
    pending.confirming = true
    try {
      // 可见窗口可能刚打开、页面还在 about:blank 或加载中；先等页面真正就绪，
      // 否则“立刻点确认”会把尚未加载的页面误当成无法判定而直接保存会话。
      try {
        await pending.page.waitFor(() => /^https?:/i.test(String(location.href)), {
          timeoutMs: 8000,
          intervalMs: 200,
        })
        await pending.page.waitFor(() => document.readyState === 'complete', {
          timeoutMs: 15000,
          intervalMs: 250,
        })
      } catch (error) {
        log('confirm：等待页面就绪超时（继续检测）', errorMessage(error))
      }
      let pageInfo = null
      try {
        pageInfo = await readPage(pending.page, { maxChars: 6000, maxLinks: 0 })
      } catch (error) {
        log('confirm：读取页面失败，按用户确认处理', errorMessage(error))
      }
      // 页面仍是真人验证 -> 不保存会话，保持窗口与 pending。
      if (pageInfo && pageInfo.challenge && pageInfo.challenge.kind !== 'none') {
        pending.phase = 'verification-required'
        pending.challengeKind = pageInfo.challenge.kind
        pending.hint = hintForChallengeKind(pageInfo.challenge.kind)
        pending.url = pageInfo.url || pending.url
        await safeSetSession(accountId, {
          status: 'verification-required',
          lastCheckedAt: nowIso(),
          detail: pending.hint,
        })
        return {
          status: 'still-required',
          detail: '页面仍显示人机验证，请在浏览器窗口中完成验证后再点击确认。',
        }
      }
      // 页面仍提示“不支持密码登录”（passkey-only 等）-> 用户尚未真正登录，继续等待。
      if (pageInfo && isPasskeyRejectionPage(pageInfo)) {
        pending.phase = 'verification-required'
        pending.challengeKind = 'login'
        pending.hint = PASSKEY_ONLY_HINT
        pending.url = pageInfo.url || pending.url
        await safeSetSession(accountId, {
          status: 'verification-required',
          lastCheckedAt: nowIso(),
          detail: PASSKEY_ONLY_HINT,
        })
        return {
          status: 'still-required',
          detail: '页面仍显示“不支持密码登录”的提示，请在窗口中用通行密钥（passkey）/ 其他方式完成登录后再点击确认。',
        }
      }
      // 同源门控：页面仍在第三方 OAuth 域（如 accounts.google.com）-> 不能确认已登录，保持窗口。
      const siteOrigin = pending.siteOrigin || siteOriginOf(pending.account)
      pending.siteOrigin = siteOrigin
      const currentUrl = (pageInfo && pageInfo.url) || ''
      if (pageInfo && currentUrl && !isSameSiteOrigin(currentUrl, siteOrigin)) {
        pending.phase = 'verification-required'
        pending.challengeKind = null
        pending.hint = `页面仍在第三方登录页（${hostOfUrl(currentUrl) || '第三方站点'}），请完成授权并等待跳回账号站点后再点击“我已完成验证”。`
        pending.url = currentUrl
        await safeSetSession(accountId, {
          status: 'verification-required',
          lastCheckedAt: nowIso(),
          detail: pending.hint,
        })
        return { status: 'still-required', detail: pending.hint }
      }
      // 确定性会话探测：探测明确显示未登录 -> still-required；
      // 探测不到（网络/CORS 等“无法判定”）-> 仍信任用户确认（保留原行为）。
      if (pageInfo) {
        const probe = await probeSessionDeterministic(pending)
        if (probe && probe.ok) {
          log('confirm：确定性探测确认已登录', accountId, probe.reason)
        } else if (probe && probe.definite) {
          pending.phase = 'verification-required'
          pending.challengeKind = null
          pending.hint = pending.loginMode === 'manual' ? MANUAL_LOGIN_HINT : GENERIC_MANUAL_CONFIRM_HINT
          pending.url = currentUrl || pending.url
          await safeSetSession(accountId, {
            status: 'verification-required',
            lastCheckedAt: nowIso(),
            detail: pending.hint,
          })
          return {
            status: 'still-required',
            detail: '会话探测显示尚未登录（仍停留在登录页），请在浏览器窗口中完成登录后再点击确认。',
          }
        } else {
          log('confirm：确定性探测无法判定，按用户确认处理', accountId, probe && probe.reason)
        }
      }
      // 成功或无法判定：按用户确认处理，保存会话并关闭窗口。
      const detail = pageInfo ? '用户手动确认完成' : '用户手动确认完成（无法读取页面状态）'
      pending.settled = true
      // 先持久化 cookie（页面还在）-> 关闭浏览器 -> 再写会话状态 -> 最后移除 pending，
      // 与 finalizePending 相同的顺序，避免 profile 竞态与“pending 已清但流程未结束”。
      try {
        await persistSessionCookies(pending)
      } finally {
        await closeBrowser(pending.browser)
      }
      await safeSetSession(accountId, {
        status: 'authenticated',
        lastLoginAt: nowIso(),
        lastCheckedAt: nowIso(),
        detail,
      })
      if (pendings.get(accountId) === pending) pendings.delete(accountId)
      const active = activeWindows.get(accountId)
      if (active && active.browser === pending.browser) activeWindows.delete(accountId)
      log('用户确认完成登录/验证', accountId)
      return { status: 'authenticated', detail }
    } finally {
      if (!pending.settled) pending.confirming = false
    }
  }

  async function cancel(accountId) {
    const pending = pendings.get(accountId)
    if (!pending) return { status: 'cancelled' }
    pending.cancel = true
    pending.settled = true
    // 先关闭浏览器（等进程真正退出）再写状态/移除 pending，避免外部看到完成后立刻复用 profile 竞态。
    try {
      await closeBrowser(pending.browser)
    } finally {
      if (pendings.get(accountId) === pending) pendings.delete(accountId)
      const active = activeWindows.get(accountId)
      if (active && active.browser === pending.browser) activeWindows.delete(accountId)
    }
    await safeSetSession(accountId, {
      status: 'unknown',
      lastCheckedAt: nowIso(),
      detail: '已取消登录/验证。',
    })
    return { status: 'cancelled' }
  }

  async function fetchPage(account, url, options = {}) {
    if (!account || !account.id) {
      return {
        status: 'error',
        url: url || '',
        title: '',
        error: { code: 'INVALID_INPUT', message: '缺少账号信息。' },
      }
    }
    const accountId = account.id
    const targetUrl = String(url || account.url || '')
    if (!/^https?:\/\//i.test(targetUrl)) {
      return {
        status: 'error',
        url: targetUrl,
        title: '',
        error: { code: 'INVALID_INPUT', message: 'URL 必须是 http/https 地址。' },
      }
    }

    // 同一账号串行：已有 pending 时直接返回 pending 状态。
    const existingPending = pendings.get(accountId)
    if (existingPending) return pendingResponse(existingPending, targetUrl)
    if (isBusy(accountId)) {
      return {
        status: 'error',
        url: targetUrl,
        title: '',
        error: { code: 'BUSY', message: '该账号正在执行其他浏览器操作，请稍后重试。' },
      }
    }

    const availability = available()
    if (!availability.browserAvailable) {
      return {
        status: 'error',
        url: targetUrl,
        title: '',
        error: { code: 'NO_BROWSER', message: availability.error || '未找到可用的浏览器。' },
      }
    }

    const headed = account.visible === true
    const maxChars =
      Number.isFinite(options.maxChars) && options.maxChars > 0
        ? Math.floor(options.maxChars)
        : config.maxTextChars

    fetchInFlight.add(accountId)
    let browser = null
    try {
      const profileDir = profileDirFor(account)
      await mkdir(profileDir, { recursive: true })
      browser = trackBrowser(
        await launchBrowserWithRetry({
          headed,
          profileDir,
          executablePath: availability.executablePath,
          timeoutMs: Math.max(25000, Number(config.pageTimeoutMs) || 30000),
        }),
        headed,
      )
      const page = await browser.newPage()
      await page.goto(targetUrl, { timeoutMs: Math.max(5000, Number(config.pageTimeoutMs) || 30000) })
      await sleep(PAGE_SETTLE_MS)
      const pageInfo = await readPage(page, { maxChars })
      const challengeKind =
        pageInfo.challenge && pageInfo.challenge.kind !== 'none' ? pageInfo.challenge.kind : null
      const passkeyOnly = isPasskeyRejectionPage(pageInfo)
      // 登录/session 类似路径 + 登录类文案：即使没有密码框也不能当成“已登录”。
      const loginLikePage =
        isLoginLikeUrl(pageInfo.url) && LOGIN_LIKE_TEXT_PATTERN.test(pageTextOf(pageInfo))
      const needsAuth = !!challengeKind || pageInfo.hasPasswordField || passkeyOnly || loginLikePage

      if (!needsAuth) {
        await safeSetSession(accountId, { status: 'authenticated', lastCheckedAt: nowIso() })
        return {
          status: 'ok',
          url: pageInfo.url,
          title: pageInfo.title,
          text: pageInfo.text,
          links: pageInfo.links,
          challenge: null,
        }
      }

      const isCaptchaLike = challengeKind === 'captcha' || challengeKind === '2fa'
      const manualMode = account.loginMode === 'manual'
      // manual 账号不自动填表；纯登录页场景在 manual 下直接进入“用户手动完成”交接。
      const hint = passkeyOnly
        ? manualMode
          ? MANUAL_LOGIN_HINT
          : PASSKEY_ONLY_HINT
        : isCaptchaLike
          ? hintForChallengeKind(challengeKind)
          : manualMode
            ? MANUAL_LOGIN_HINT
            : '登录状态已失效，需要重新登录。已打开可见浏览器窗口，请登录后点击“我已完成验证”。'
      await safeSetSession(accountId, {
        status: isCaptchaLike ? 'verification-required' : 'expired',
        lastCheckedAt: nowIso(),
        detail: hint,
      })

      // 先关闭 headless，避免同一 profile 被两个浏览器实例占用。
      await closeBrowser(browser)
      browser = null

      if (!config.autoOpenOnChallenge) {
        return {
          status: isCaptchaLike ? 'verification-required' : 'login-required',
          url: pageInfo.url,
          title: pageInfo.title,
          challenge: pageInfo.challenge,
          hint,
        }
      }

      const opened = await openVisibleWindow(account, pageInfo.url, {
        phase: isCaptchaLike || manualMode ? 'verification-required' : 'logging-in',
        hint,
        challengeKind: isCaptchaLike ? challengeKind : null,
        fill: !manualMode,
      })
      if (opened.status === 'started') {
        return {
          status: isCaptchaLike ? 'verification-required' : 'login-required',
          url: pageInfo.url,
          title: pageInfo.title,
          challenge: pageInfo.challenge,
          pending: opened.pending,
          hint: opened.pending ? opened.pending.hint : hint,
        }
      }
      return {
        status: isCaptchaLike ? 'verification-required' : 'login-required',
        url: pageInfo.url,
        title: pageInfo.title,
        challenge: pageInfo.challenge,
        hint: `检测到需要登录/真人验证，但打开可见浏览器窗口失败：${
          (opened.error && opened.error.message) || '未知错误'
        }`,
      }
    } catch (error) {
      log('fetch 失败', accountId, errorMessage(error))
      const info = errorInfo(error)
      await safeSetSession(accountId, {
        status: 'error',
        lastCheckedAt: nowIso(),
        detail: `读取页面失败：${info.message}`,
      })
      return { status: 'error', url: targetUrl, title: '', error: info }
    } finally {
      fetchInFlight.delete(accountId)
      if (browser) await closeBrowser(browser)
    }
  }

  function pendingResponse(pending, fallbackUrl) {
    const isChallenge = pending.phase === 'verification-required' || !!pending.challengeKind
    return {
      status: isChallenge ? 'verification-required' : 'login-required',
      url: pending.url || fallbackUrl || '',
      title: '',
      challenge: isChallenge
        ? { kind: pending.challengeKind || 'login', evidence: '等待用户在可见浏览器窗口中完成验证' }
        : { kind: 'login', evidence: '等待用户在可见浏览器窗口中完成登录' },
      pending: publicPending(pending),
      hint: pending.hint,
    }
  }

  async function search(account, query, options = {}) {
    const keyword = String(query === undefined || query === null ? '' : query).trim()
    if (!keyword) {
      return {
        status: 'error',
        error: { code: 'INVALID_INPUT', message: '搜索关键词不能为空。' },
      }
    }
    const template = typeof account.searchUrl === 'string' ? account.searchUrl : ''
    let usedUrl = ''
    let guessed = false
    if (template && template.includes('{query}')) {
      usedUrl = template.split('{query}').join(encodeURIComponent(keyword))
    } else {
      try {
        const origin = new URL(account.url).origin
        usedUrl = `${origin}/search?q=${encodeURIComponent(keyword)}`
        guessed = true
      } catch {
        return {
          status: 'error',
          error: { code: 'INVALID_INPUT', message: '账号的网站地址无效，无法构造搜索地址。' },
        }
      }
    }
    const result = await fetchPage(account, usedUrl, options)
    const output = { ...result, usedUrl }
    if (guessed) {
      output.guessed = true
      if (output.status !== 'ok' && !output.hint) {
        output.hint = '搜索地址为按站点根路径猜测的地址，可在账号设置中配置“搜索地址模板”。'
      }
    }
    return output
  }

  async function closeAll() {
    const currentPendings = [...pendings.entries()]
    for (const [, pending] of currentPendings) {
      pending.cancel = true
      pending.settled = true
    }
    startingWindows.clear()
    fetchInFlight.clear()
    const browsers = [...liveBrowsers]
    liveBrowsers.clear()
    // 先真正关闭浏览器进程，再清理 pending/active 状态。
    await Promise.allSettled(browsers.map((browser) => browser.close()))
    for (const [accountId, pending] of currentPendings) {
      if (pendings.get(accountId) === pending) pendings.delete(accountId)
    }
    activeWindows.clear()
    log('已关闭全部浏览器窗口', browsers.length)
  }

  async function removeProfile(accountId) {
    try {
      await cancel(accountId)
    } catch (error) {
      log('removeProfile: cancel 失败（忽略）', errorMessage(error))
    }
    const profileDir = profileDirFor(accountId)
    try {
      await rm(profileDir, { recursive: true, force: true, maxRetries: 3 })
      log('已删除账号 profile 目录', sanitizeProfileSegment(accountId))
    } catch (error) {
      log('删除账号 profile 目录失败（忽略）', sanitizeProfileSegment(accountId), errorMessage(error))
    }
  }

  /**
   * 诊断/测试用：读取 pending 可见窗口的页面状态，以及表单是否已被填写
   * （只返回布尔值/长度，绝不返回字段值，避免泄漏密码）。
   */
  async function debugPendingPage(accountId) {
    const pending = pendings.get(accountId)
    if (!pending) return null
    const base = {
      accountId,
      phase: pending.phase,
      loginMode: pending.loginMode || 'auto',
      hint: pending.hint,
      url: pending.url,
    }
    let pageInfo = null
    try {
      pageInfo = await readPage(pending.page, { maxChars: 800, maxLinks: 0 })
    } catch (error) {
      return { ...base, error: errorMessage(error) }
    }
    let fields = null
    try {
      fields = await pending.page.evaluate(() => {
        const isVisible = (element) => {
          try {
            if (!element || !element.isConnected) return false
            const style = window.getComputedStyle(element)
            if (style.display === 'none' || style.visibility === 'hidden') return false
            const rect = element.getBoundingClientRect()
            return rect.width > 0 && rect.height > 0
          } catch {
            return false
          }
        }
        const inputs = Array.from(document.querySelectorAll('input'))
        const visibleInputs = inputs.filter(isVisible)
        const usernameInput = visibleInputs.find((input) => {
          const type = String(input.getAttribute('type') || 'text').toLowerCase()
          return type !== 'password' && type !== 'hidden'
        })
        const passwordInput = visibleInputs.find(
          (input) => String(input.getAttribute('type') || '').toLowerCase() === 'password',
        )
        return {
          visibleInputCount: visibleInputs.length,
          usernameFilled: usernameInput ? String(usernameInput.value || '').length > 0 : null,
          passwordFilled: passwordInput ? String(passwordInput.value || '').length > 0 : null,
        }
      })
    } catch {
      fields = null
    }
    return { ...base, url: pageInfo.url || base.url, title: pageInfo.title, hasPasswordField: pageInfo.hasPasswordField, challenge: pageInfo.challenge, fields }
  }

  function debugState() {
    return {
      profilesDir,
      pendings: [...pendings.keys()],
      active: [...activeWindows.entries()].map(([accountId, item]) => ({
        accountId,
        pid: item.browser && item.browser.pid,
        closed: !!(item.browser && item.browser.closed),
      })),
      browsers: [...liveBrowsers].map((browser) => ({
        pid: browser.pid,
        closed: browser.closed,
        headed: !!browser.headed,
      })),
      launchedPids: [...launchedBrowserPids],
      fetchInFlight: [...fetchInFlight],
      startingWindows: [...startingWindows],
    }
  }

  return {
    profilesDir,
    available,
    pending,
    pendingFor,
    pendingList,
    pendingCount,
    isBusy,
    login,
    confirm,
    cancel,
    fetch: fetchPage,
    search,
    closeAll,
    removeProfile,
    debugState,
    debugPendingPage,
  }
}
