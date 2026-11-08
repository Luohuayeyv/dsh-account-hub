/**
 * dsh-account-hub — Host entry point.
 *
 * Wires the encrypted store, the Edge/CDP browser manager, the shared account
 * service, the Settings HTTP routes and the agent tools together, then registers a
 * short system-prompt section that tells agents which saved site accounts exist.
 *
 * Everything is registered inside `apply`; the returned cleanup closures are attached
 * with `ctx.effect` so unloading the plugin closes every browser window it opened.
 * A failure while initializing the store is logged and swallowed: a broken account
 * hub must never block the rest of the profile from starting.
 */

import os from 'node:os'
import path from 'node:path'
import { createStore } from './lib/store.js'
import { createBrowserManager } from './lib/browser.js'
import { createAccountService } from './lib/accountService.js'
import { registerRoutes } from './lib/routes.js'
import { registerTools } from './lib/tools.js'

export const inject = ['tools']

const LOG_PREFIX = '[account-hub]'
const DEFAULT_PROMPT_ORDER = 70
const BROWSER_CONFIG_KEYS = ['browserPath', 'loginTimeoutMs', 'pageTimeoutMs', 'maxTextChars', 'autoOpenOnChallenge', 'pollIntervalMs']

/** Default data directory: `$DSH_HOME/account-hub` (falling back to `~/.dsh`). */
export function resolveDataDir(config = {}) {
  if (config && typeof config === 'object' && typeof config.dataDir === 'string' && config.dataDir.trim()) {
    return path.resolve(config.dataDir)
  }
  const dshHome = process.env.DSH_HOME && String(process.env.DSH_HOME).trim()
    ? String(process.env.DSH_HOME).trim()
    : path.join(os.homedir(), '.dsh')
  return path.join(dshHome, 'account-hub')
}

function buildBrowserConfig(config) {
  const out = {}
  if (!config || typeof config !== 'object') return out
  for (const key of BROWSER_CONFIG_KEYS) {
    if (config[key] !== undefined) out[key] = config[key]
  }
  return out
}

function hostOf(url) {
  try {
    return new URL(url).hostname
  } catch {
    return String(url || '')
  }
}

/** Short system-prompt section: what the tools are for plus saved account labels. */
function buildPromptText(accounts) {
  const list = Array.isArray(accounts) ? accounts.filter((account) => account && account.label) : []
  if (list.length === 0) return ''
  const lines = list.map((account) => `- ${account.label}（${hostOf(account.url)}）`)
  return [
    'Site accounts (account-hub): the user has saved login sessions for the sites below.',
    'When web_search / web_fetch cannot reach content because the site requires a login, a subscription/paywall, or a captcha / human verification, use account_hub_search or account_hub_fetch with the matching saved account instead.',
    'If the result says verification-required or login-required, call account_hub_login to open a visible browser window for the user, then retry once they confirm. Never ask the user for a password in chat; credentials are already stored locally and encrypted.',
    'Saved accounts:',
    ...lines,
  ].join('\n')
}

async function registerSystemPromptSection(ctx, service, config, log) {
  const systemPrompt = ctx && typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined
  if (!systemPrompt || typeof systemPrompt.section !== 'function') {
    log('systemPrompt 服务不可用，跳过提示词段落')
    return
  }
  let accounts = []
  try {
    accounts = await service.list()
  } catch (error) {
    console.warn(`${LOG_PREFIX} 读取账号列表用于提示词失败：${error?.message || error}`)
  }
  if (typeof service.onChange === 'function') {
    try {
      service.onChange((next) => {
        accounts = Array.isArray(next) ? next : []
      })
    } catch (error) {
      console.warn(`${LOG_PREFIX} 订阅账号变更失败：${error?.message || error}`)
    }
  }
  const order = config && Number.isFinite(config.promptOrder) ? config.promptOrder : DEFAULT_PROMPT_ORDER
  let disposeSection = () => {}
  try {
    const disposer = systemPrompt.section({
      name: 'account-hub',
      order,
      text: () => buildPromptText(accounts),
    })
    if (typeof disposer === 'function') disposeSection = disposer
  } catch (error) {
    console.error(`${LOG_PREFIX} 注册 system prompt 段落失败：${error?.message || error}`)
    return
  }
  if (ctx && typeof ctx.effect === 'function') {
    let disposed = false
    try {
      ctx.effect(() => () => {
        if (disposed) return
        disposed = true
        try {
          disposeSection()
        } catch (error) {
          console.error(`${LOG_PREFIX} 释放 system prompt 段落失败：${error?.message || error}`)
        }
      })
    } catch (error) {
      console.error(`${LOG_PREFIX} 注册提示词段落卸载钩子失败：${error?.message || error}`)
    }
  }
  log('已注册 system prompt 段落（账号名称列表）')
}

/**
 * @param {object} ctx cordis plugin context
 * @param {{dataDir?: string, promptOrder?: number, browserPath?: string, loginTimeoutMs?: number,
 *          pageTimeoutMs?: number, maxTextChars?: number, autoOpenOnChallenge?: boolean,
 *          pollIntervalMs?: number}} [config]
 */
export function apply(ctx, config = {}) {
  const cfg = config && typeof config === 'object' ? config : {}
  const log = (...args) => console.log(LOG_PREFIX, ...args)
  const dataDir = resolveDataDir(cfg)
  const profilesDir = path.join(dataDir, 'profiles')
  let service = null
  let disposed = false

  // Register cleanup before doing any async work so an unload during startup is safe.
  if (ctx && typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => () => {
        disposed = true
        const current = service
        service = null
        if (current && typeof current.close === 'function') {
          Promise.resolve()
            .then(() => current.close())
            .catch((error) => console.error(`${LOG_PREFIX} 关闭浏览器失败：${error?.message || error}`))
        }
      })
    } catch (error) {
      console.error(`${LOG_PREFIX} 注册卸载清理失败：${error?.message || error}`)
    }
  }

  async function init() {
    const store = await createStore({ dir: dataDir })
    if (disposed) {
      log('插件已卸载，跳过初始化')
      return
    }
    const browserConfig = buildBrowserConfig(cfg)
    const browser = createBrowserManager({ store, profilesDir, config: browserConfig, log })
    service = createAccountService({ store, browser, config: browserConfig, log, profilesDir })
    if (disposed) {
      try {
        await service.close()
      } catch (error) {
        console.error(`${LOG_PREFIX} 关闭浏览器失败：${error?.message || error}`)
      }
      service = null
      return
    }

    // Route and tool registration are isolated: one failure must not block the other.
    try {
      registerRoutes(ctx, service, { log })
    } catch (error) {
      console.error(`${LOG_PREFIX} 注册 HTTP 路由失败：${error?.message || error}`)
    }
    try {
      registerTools(ctx, service, { log })
    } catch (error) {
      console.error(`${LOG_PREFIX} 注册 agent 工具失败：${error?.message || error}`)
    }
    try {
      await registerSystemPromptSection(ctx, service, cfg, log)
    } catch (error) {
      console.error(`${LOG_PREFIX} 注册 system prompt 段落失败：${error?.message || error}`)
    }
    log(`账号中心已就绪（数据目录：${dataDir}）`)
  }

  init().catch((error) => {
    console.error(`${LOG_PREFIX} 初始化失败，账号中心不可用（其他插件不受影响）`, error)
  })
}
