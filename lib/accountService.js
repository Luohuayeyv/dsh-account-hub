/**
 * dsh-account-hub — account service.
 *
 * The single implementation of every account operation. The Settings UI reaches it
 * through the HTTP routes (lib/routes.js) and agents reach it through the tools
 * (lib/tools.js); both go through the same methods so behaviour cannot drift.
 *
 * Failures are surfaced as Errors carrying `code` (INVALID_INPUT / NOT_FOUND /
 * AMBIGUOUS / NO_BROWSER / BUSY / DECRYPT_FAILED / ...) and a user-facing message.
 * Status-returning browser flows (login / confirm / cancel / test) keep their
 * explicit status objects instead of throwing.
 */

import { rm } from 'node:fs/promises'
import path from 'node:path'
import { hubError } from './store.js'

export { hubError }

const MAX_MAX_CHARS = 200000
const TEST_TEXT_CHARS = 300

/** Normalize a thrown Error into the `{ code, message }` shape used on the wire. */
export function toErrorPayload(error) {
  const code = error && typeof error.code === 'string' && error.code ? error.code : 'INTERNAL'
  const message = error && error.message ? String(error.message) : '未知错误'
  return { code, message }
}

function errorObject(code, message) {
  return { code, message }
}

function requireText(value, fieldLabel) {
  if (typeof value !== 'string' || !value.trim()) throw hubError('INVALID_INPUT', `${fieldLabel}必须是非空字符串`)
  return value.trim()
}

function normalizeMaxChars(value) {
  if (value === undefined || value === null || value === '') return undefined
  const num = typeof value === 'string' ? Number(value) : value
  if (typeof num !== 'number' || !Number.isInteger(num) || num <= 0 || num > MAX_MAX_CHARS) {
    throw hubError('INVALID_INPUT', `maxChars 必须是 1 到 ${MAX_MAX_CHARS} 之间的整数`)
  }
  return num
}

function buildBrowserOptions(opts) {
  const options = {}
  if (opts && typeof opts === 'object' && opts.maxChars !== undefined) {
    const maxChars = normalizeMaxChars(opts.maxChars)
    if (maxChars !== undefined) options.maxChars = maxChars
  }
  return options
}

function requireHttpUrl(value) {
  const text = requireText(value, '网址')
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    throw hubError('INVALID_INPUT', `不是有效网址：${text}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw hubError('INVALID_INPUT', '只支持 http 或 https 网址')
  return text
}

/**
 * @param {{
 *   store: object,
 *   browser: object,
 *   config?: object,
 *   log?: (...args:any[])=>void,
 *   profilesDir?: string,
 * }} options
 */
export function createAccountService({ store, browser, config = {}, log = () => {}, profilesDir = '' } = {}) {
  if (!store || typeof store.list !== 'function') throw hubError('INTERNAL', 'createAccountService 需要 store')
  if (!browser || typeof browser.fetch !== 'function') throw hubError('INTERNAL', 'createAccountService 需要 browser manager')

  const changeListeners = new Set()

  function emitChange() {
    if (changeListeners.size === 0) return
    store
      .list()
      .then((accounts) => {
        for (const listener of [...changeListeners]) {
          try {
            listener(accounts)
          } catch (error) {
            log('[account-hub] 账号变更监听器失败', error?.message || error)
          }
        }
      })
      .catch((error) => log('[account-hub] 刷新账号缓存失败', error?.message || error))
  }

  async function requireRecord(id) {
    const record = await store.get(id)
    if (!record) throw hubError('NOT_FOUND', `账号不存在：${String(id)}`)
    return record
  }

  function publicOf(record) {
    const { password: _password, ...publicAccount } = record
    return publicAccount
  }

  function safePending() {
    try {
      const pending = browser.pending()
      return pending && typeof pending === 'object' ? { ...pending } : null
    } catch (error) {
      log('[account-hub] 读取浏览器 pending 状态失败', error?.message || error)
      return null
    }
  }

  function safeAvailability() {
    try {
      const info = browser.available()
      if (info && typeof info === 'object') {
        return {
          available: info.browserAvailable === true,
          executablePath: typeof info.executablePath === 'string' ? info.executablePath : undefined,
          error: typeof info.error === 'string' ? info.error : undefined,
        }
      }
    } catch (error) {
      return { available: false, error: error?.message || String(error) }
    }
    return { available: false, error: '浏览器管理器未提供可用性信息' }
  }

  // ---- operations ------------------------------------------------------

  async function list() {
    return store.list()
  }

  async function state() {
    const accounts = await store.list()
    const pending = safePending()
    const browserInfo = safeAvailability()
    let browserPendingCount = pending ? 1 : 0
    if (!pending && typeof browser.isBusy === 'function') {
      browserPendingCount = 0
      for (const account of accounts) {
        try {
          if (browser.isBusy(account.id)) browserPendingCount += 1
        } catch {
          /* ignore one bad probe */
        }
      }
    }
    return { accounts, pending, browser: browserInfo, browserPendingCount }
  }

  async function create(input) {
    const account = await store.create(input)
    emitChange()
    return account
  }

  async function update(id, patch) {
    const account = await store.update(id, patch)
    emitChange()
    return account
  }

  async function removeProfile(accountId) {
    if (browser && typeof browser.removeProfile === 'function') {
      try {
        await browser.removeProfile(accountId)
        return
      } catch (error) {
        log('[account-hub] 清理浏览器 profile 失败（忽略）', error?.message || error)
        return
      }
    }
    // Fallback when an older browser manager has no removeProfile yet.
    if (!profilesDir) return
    try {
      await rm(path.join(profilesDir, accountId), { recursive: true, force: true })
    } catch (error) {
      log('[account-hub] 删除浏览器 profile 目录失败（忽略）', error?.message || error)
    }
  }

  async function remove(id) {
    const record = await requireRecord(id)
    if (typeof browser.cancel === 'function') {
      try {
        await browser.cancel(record.id)
      } catch (error) {
        log('[account-hub] 删除账号前取消登录失败（忽略）', error?.message || error)
      }
    }
    await removeProfile(record.id)
    await store.remove(record.id)
    emitChange()
  }

  async function login(id) {
    const record = await requireRecord(id)
    try {
      const result = await browser.login(record.id)
      const latestPending = safePending()
      // The manager returns the matching pending entry; fall back to the latest one.
      const pending = (result && result.pending) || latestPending
      if (result && result.status === 'started') {
        return {
          status: 'started',
          pending,
          message: result.hint || '已打开浏览器窗口，请在窗口中完成登录或真人验证，然后点击“我已完成验证”。',
        }
      }
      if (result && result.status === 'busy') {
        return {
          status: 'busy',
          pending,
          message: result.hint || '该账号正在进行登录或验证流程，请先完成或取消当前流程。',
        }
      }
      const error = (result && result.error) || errorObject('LOGIN_FAILED', '无法启动登录流程')
      return { status: 'error', message: error.message || '无法启动登录流程', error, pending }
    } catch (error) {
      const payload = toErrorPayload(error)
      return { status: 'error', message: payload.message, error: payload, pending: safePending() }
    }
  }

  async function confirmLogin(id) {
    const record = await requireRecord(id)
    try {
      const result = await browser.confirm(record.id)
      const status = result && result.status
      if (status === 'authenticated') {
        return { status: 'authenticated', message: result.detail || '会话已保存。' }
      }
      if (status === 'still-required') {
        return { status: 'still-required', message: result.detail || '页面仍显示需要完成验证，请在浏览器窗口中完成后再确认。' }
      }
      const error = (result && result.error) || errorObject('CONFIRM_FAILED', '无法确认登录状态')
      const detail = (result && (result.detail || result.message)) || ''
      return { status: 'error', message: detail || error.message || '无法确认登录状态', error }
    } catch (error) {
      const payload = toErrorPayload(error)
      return { status: 'error', message: payload.message, error: payload }
    }
  }

  async function cancelLogin(id) {
    await requireRecord(id)
    try {
      const result = await browser.cancel(id)
      const status = (result && result.status) || 'cancelled'
      return { status: status === 'error' ? 'error' : 'cancelled', message: result?.detail || result?.message || '' }
    } catch (error) {
      const payload = toErrorPayload(error)
      return { status: 'error', message: payload.message, error: payload }
    }
  }

  async function test(id) {
    const record = await requireRecord(id)
    try {
      const result = await browser.fetch(record, record.url, { maxChars: 2000 })
      const status = result && result.status
      if (status === 'ok') {
        const text = typeof result.text === 'string' ? result.text : ''
        return {
          status: 'ok',
          title: typeof result.title === 'string' ? result.title : '',
          url: typeof result.url === 'string' ? result.url : record.url,
          textSnippet: text.slice(0, TEST_TEXT_CHARS),
          message: '会话可用。',
        }
      }
      if (status === 'verification-required' || status === 'login-required') {
        return {
          status,
          title: typeof result.title === 'string' ? result.title : '',
          url: typeof result.url === 'string' ? result.url : record.url,
          message: result.hint || (status === 'verification-required' ? '需要完成真人验证。' : '需要重新登录。'),
          pending: result.pending ?? safePending(),
        }
      }
      const error = (result && result.error) || errorObject('TEST_FAILED', '测试会话失败')
      return { status: 'error', message: error.message || '测试会话失败', error }
    } catch (error) {
      const payload = toErrorPayload(error)
      return { status: 'error', message: payload.message, error: payload }
    }
  }

  async function fetchAccount(id, url, opts) {
    const record = await requireRecord(id)
    const targetUrl = requireHttpUrl(url)
    return browser.fetch(record, targetUrl, buildBrowserOptions(opts))
  }

  async function search(id, query, opts) {
    const record = await requireRecord(id)
    const text = requireText(query, '搜索关键词')
    return browser.search(record, text, buildBrowserOptions(opts))
  }

  async function resolveAccount(ref) {
    if (typeof ref !== 'string' || !ref.trim()) throw hubError('INVALID_INPUT', '请提供账号 id 或名称')
    const needle = ref.trim()
    const exact = await store.get(needle)
    if (exact) return publicOf(exact)
    const accounts = await store.list()
    const lower = needle.toLowerCase()
    const matches = accounts.filter((account) => String(account.label || '').toLowerCase() === lower)
    if (matches.length === 1) return matches[0]
    if (matches.length > 1) throw hubError('AMBIGUOUS', `有多个账号名为“${needle}”，请改用账号 id`)
    throw hubError('NOT_FOUND', `未找到账号“${needle}”；可先调用 account_hub_list 查看已保存账号`)
  }

  async function close() {
    try {
      if (typeof browser.closeAll === 'function') await browser.closeAll()
    } catch (error) {
      log('[account-hub] 关闭浏览器失败', error?.message || error)
    }
  }

  const service = {
    list,
    state,
    create,
    update,
    remove,
    login,
    confirmLogin,
    cancelLogin,
    test,
    fetch: fetchAccount,
    search,
    resolveAccount,
    close,
    /** Subscribe to account-list changes (used by the optional system-prompt section). */
    onChange(listener) {
      if (typeof listener !== 'function') return () => {}
      changeListeners.add(listener)
      return () => changeListeners.delete(listener)
    },
  }
  return service
}
