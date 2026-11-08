// lib/cdp.js
//
// 零依赖 CDP（Chrome DevTools Protocol）客户端：启动本机 Microsoft Edge / Google Chrome，
// 连接其 DevTools 调试端口，提供 Browser / Page 两级 API。
// 只使用 node:* 内置模块与 Node 24 的全局 fetch / WebSocket，不依赖任何 npm 包。
//
// 稳定性约定：
//  - 所有 CDP 请求都有超时上限（CDP_TIMEOUT），不允许无限等待。
//  - 浏览器进程退出 / 调试连接断开 / 页面 target 被关闭时，后续调用抛带 code 的 Error（CDP_ERROR）。
//  - close() 幂等：先 Browser.close，等待进程退出，必要时 taskkill /T /F 兜底。
//  - 错误 code：NO_BROWSER（找不到/无法启动浏览器）、CDP_TIMEOUT、CDP_ERROR。

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const DEFAULT_CDP_TIMEOUT_MS = 15000
const WS_CONNECT_TIMEOUT_MS = 10000
const CHILD_EXIT_WAIT_MS = 6000

export const BROWSER_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge Beta\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/microsoft-edge',
  '/usr/bin/microsoft-edge-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

/** 构造带 code 的错误（browser.js 也会用）。 */
export function makeError(message, code = 'CDP_ERROR', cause) {
  const error = new Error(message)
  error.code = code
  if (cause !== undefined) error.cause = cause
  return error
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Promise 超时包装：超时后以 code=CDP_TIMEOUT 拒绝。
 * 注意：底层 promise 稍后 settle 时不会产生 unhandledRejection（race 已挂处理器）。
 */
function withTimeout(promise, timeoutMs, message, code = 'CDP_TIMEOUT') {
  let timer = null
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(makeError(message, code)), Math.max(100, timeoutMs))
    if (timer && typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/** 查找浏览器可执行文件；显式路径优先，找不到抛 code=NO_BROWSER。 */
export function findBrowserExecutable(explicitPath) {
  if (explicitPath) {
    try {
      if (existsSync(explicitPath)) return explicitPath
    } catch {
      /* ignore */
    }
    throw makeError(`浏览器可执行文件不存在：${explicitPath}`, 'NO_BROWSER')
  }
  for (const candidate of BROWSER_CANDIDATES) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      /* ignore */
    }
  }
  throw makeError(
    '未找到可用的浏览器（Microsoft Edge / Google Chrome）。请先安装 Microsoft Edge，或在账号中心设置里配置浏览器路径。',
    'NO_BROWSER',
  )
}

function waitForChildExit(child, timeoutMs) {
  if (!child) return Promise.resolve(true)
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    let done = false
    let timer = null
    const finish = (value) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      try {
        child.removeListener('exit', onExit)
      } catch {
        /* ignore */
      }
      resolve(value)
    }
    const onExit = () => finish(true)
    timer = setTimeout(() => finish(false), Math.max(100, timeoutMs))
    child.once('exit', onExit)
  })
}

function runCommand(command, args, timeoutMs) {
  return new Promise((resolve) => {
    let done = false
    let timer = null
    let proc = null
    const finish = (value) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      resolve(value)
    }
    try {
      proc = spawn(command, args, { stdio: 'ignore', windowsHide: true })
    } catch {
      resolve(false)
      return
    }
    timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        /* ignore */
      }
      finish(false)
    }, Math.max(500, timeoutMs))
    proc.once('exit', () => finish(true))
    proc.once('error', () => finish(false))
  })
}

/** 结束浏览器进程：先温和 kill，超时后 Windows 上用 taskkill /T /F 兜底（连带子进程）。 */
async function killChildProcess(child) {
  if (!child) return
  if (child.exitCode !== null || child.signalCode !== null) return
  try {
    child.kill()
  } catch {
    /* ignore */
  }
  if (await waitForChildExit(child, 2500)) return
  if (process.platform === 'win32' && child.pid) {
    await runCommand('taskkill', ['/PID', String(child.pid), '/T', '/F'], 5000)
  }
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill('SIGKILL')
    } catch {
      /* ignore */
    }
  }
  await waitForChildExit(child, 3000)
}

async function waitForDevToolsPort(profileDir, childState, timeoutMs) {
  const portFile = join(profileDir, 'DevToolsActivePort')
  const deadline = Date.now() + Math.max(3000, timeoutMs)
  while (Date.now() < deadline) {
    if (childState.error) {
      throw makeError(`浏览器启动失败：${childState.error.message || String(childState.error)}`, 'NO_BROWSER', childState.error)
    }
    if (childState.exited) {
      throw makeError(
        `浏览器进程在启动过程中退出（exit code ${childState.code}）。若该账号的浏览窗口已在运行，请先关闭后重试。`,
        'CDP_ERROR',
      )
    }
    let raw = null
    try {
      raw = readFileSync(portFile, 'utf8')
    } catch {
      /* 文件还没写出来 */
    }
    if (raw) {
      const lines = raw.split(/\r?\n/)
      const port = Number(String(lines[0] || '').trim())
      if (Number.isInteger(port) && port > 0) {
        return { port, wsPath: String(lines[1] || '').trim() }
      }
    }
    await sleep(100)
  }
  throw makeError(`启动浏览器超时（${timeoutMs}ms）：未获得 DevTools 调试端口。`, 'CDP_TIMEOUT')
}

async function fetchVersionInfo(port, childState, timeoutMs) {
  const deadline = Date.now() + Math.max(3000, timeoutMs)
  let lastError = null
  while (Date.now() < deadline) {
    if (childState.exited) throw makeError('浏览器进程已退出，无法读取调试信息。', 'CDP_ERROR')
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(3000),
      })
      if (response.ok) {
        const data = await response.json()
        if (data && (data.webSocketDebuggerUrl || data.Browser)) return data
        lastError = makeError('/json/version 返回内容缺少 webSocketDebuggerUrl', 'CDP_ERROR')
      } else {
        lastError = makeError(`读取 /json/version 失败：HTTP ${response.status}`, 'CDP_ERROR')
      }
    } catch (error) {
      lastError = error
    }
    await sleep(120)
  }
  throw makeError(
    `无法读取浏览器调试信息（/json/version）：${lastError ? lastError.message : '超时'}`,
    'CDP_TIMEOUT',
  )
}

function connectWebSocket(url, timeoutMs) {
  const ws = new WebSocket(url)
  const openPromise = new Promise((resolve, reject) => {
    const cleanup = () => {
      try {
        ws.removeEventListener('open', onOpen)
        ws.removeEventListener('error', onError)
      } catch {
        /* ignore */
      }
    }
    const onOpen = () => {
      cleanup()
      resolve()
    }
    const onError = (event) => {
      cleanup()
      reject(
        makeError(
          `无法连接浏览器调试端口（WebSocket）：${event?.message || event?.error?.message || 'unknown'}`,
          'CDP_ERROR',
        ),
      )
    }
    ws.addEventListener('open', onOpen)
    ws.addEventListener('error', onError)
  })
  return withTimeout(openPromise, timeoutMs, `连接浏览器调试端口超时（${timeoutMs}ms）`).then(
    () => ws,
    (error) => {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      throw error
    },
  )
}

/**
 * 启动浏览器实例。
 * @param {object} options
 * @param {boolean} [options.headed=false]       false => --headless=new
 * @param {string}  options.profileDir           用户数据目录（必填，每个账号一个）
 * @param {string}  [options.executablePath]     显式浏览器路径
 * @param {{width:number,height:number}} [options.windowSize]
 * @param {number}  [options.timeoutMs=25000]    启动 + 连接超时
 * @param {string[]} [options.extraArgs]
 * @returns {Promise<Browser>}
 */
export async function launchBrowser(options = {}) {
  const {
    headed = false,
    timeoutMs = 25000,
    windowSize = { width: 1280, height: 900 },
    extraArgs = [],
  } = options || {}
  const profileDir = options && options.profileDir
  if (!profileDir) throw makeError('launchBrowser 需要 profileDir 参数。', 'CDP_ERROR')

  const executablePath = findBrowserExecutable(options.executablePath)
  await mkdir(profileDir, { recursive: true })
  // 同一 profile 目录可能残留上次的 DevToolsActivePort，先删掉避免读到过期端口。
  try {
    rmSync(join(profileDir, 'DevToolsActivePort'), { force: true })
  } catch {
    /* ignore */
  }

  const width = Math.max(320, Number(windowSize && windowSize.width) || 1280)
  const height = Math.max(240, Number(windowSize && windowSize.height) || 900)
  const args = [
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-default-apps',
    '--disable-component-update',
    '--disable-features=Translate,OptimizationHints,MediaRouter',
    '--disable-dev-shm-usage',
    '--mute-audio',
    `--window-size=${width},${height}`,
  ]
  if (!headed) {
    args.push('--headless=new', '--disable-gpu', '--hide-scrollbars')
  } else {
    // 可见窗口：确保窗口正常显示（不要以最小化/隐藏方式启动）。
    args.push('--new-window')
  }
  for (const arg of extraArgs || []) {
    if (typeof arg === 'string' && arg) args.push(arg)
  }
  args.push('about:blank')

  const childState = { exited: false, code: null, error: null }
  let child
  try {
    // 关键：headed 模式不能设置 windowsHide（Windows 上会以 SW_HIDE 启动，窗口可能被隐藏），
    // headless 模式则隐藏控制台窗口。
    child = spawn(executablePath, args, { stdio: 'ignore', windowsHide: !headed })
  } catch (error) {
    throw makeError(`无法启动浏览器：${error.message}`, 'NO_BROWSER', error)
  }
  child.once('error', (error) => {
    childState.error = error
  })
  child.once('exit', (code, signal) => {
    childState.exited = true
    childState.code = code
    if (signal) childState.error = childState.error || null
  })

  try {
    const portInfo = await waitForDevToolsPort(profileDir, childState, timeoutMs)
    const versionInfo = await fetchVersionInfo(portInfo.port, childState, timeoutMs)
    const wsUrl =
      versionInfo.webSocketDebuggerUrl ||
      `ws://127.0.0.1:${portInfo.port}${portInfo.wsPath || '/devtools/browser'}`
    const ws = await connectWebSocket(wsUrl, Math.min(WS_CONNECT_TIMEOUT_MS, Math.max(3000, timeoutMs)))
    return new Browser({ child, port: portInfo.port, executablePath, ws, versionInfo })
  } catch (error) {
    await killChildProcess(child)
    throw error
  }
}

/** 一个已连接的浏览器实例（browser-level WebSocket，flat session 模式）。 */
class Browser {
  constructor({ child, port, executablePath, ws, versionInfo }) {
    this.pid = (child && child.pid) || 0
    this.port = port
    this.executablePath = executablePath
    this.closed = false

    this._child = child
    this._ws = ws
    this._versionInfo = versionInfo || null
    this._nextId = 0
    this._pending = new Map()
    this._pages = new Set()
    this._sessions = new Map()
    this._closePromise = null

    // 保持一个 error 监听，避免 WebSocket 未处理的 error 事件导致进程崩溃；真正的断开靠 close 事件感知。
    this._ws.addEventListener('error', () => {})
    this._ws.addEventListener('message', (event) => this._onMessage(event))
    this._ws.addEventListener('close', () => {
      this._handleDisconnect(makeError('浏览器调试连接已断开。', 'CDP_ERROR'))
    })
    this._child.once('exit', (code, signal) => {
      this.closed = true
      const message = `浏览器进程已退出（code=${code}${signal ? `, signal=${signal}` : ''}），操作已中断。`
      this._handleDisconnect(makeError(message, 'CDP_ERROR'))
    })
    if (this._child.exitCode !== null || this._child.signalCode !== null) this.closed = true
  }

  _handleDisconnect(error) {
    this.closed = true
    this._rejectAll(error)
    for (const page of [...this._pages]) {
      try {
        page._markClosed()
      } catch {
        /* ignore */
      }
    }
    this._pages.clear()
    this._sessions.clear()
  }

  _rejectAll(error) {
    for (const [, entry] of this._pending) {
      try {
        clearTimeout(entry.timer)
      } catch {
        /* ignore */
      }
      try {
        entry.reject(error)
      } catch {
        /* ignore */
      }
    }
    this._pending.clear()
  }

  _onMessage(event) {
    let raw = event && event.data
    if (raw instanceof ArrayBuffer) {
      try {
        raw = new TextDecoder().decode(raw)
      } catch {
        return
      }
    } else if (typeof raw !== 'string') {
      if (raw && typeof raw.text === 'function') {
        raw
          .text()
          .then((text) => this._handleRawMessage(text))
          .catch(() => {})
        return
      }
      try {
        raw = String(raw)
      } catch {
        return
      }
    }
    this._handleRawMessage(raw)
  }

  _handleRawMessage(raw) {
    let message
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    if (message.id !== undefined) {
      const entry = this._pending.get(message.id)
      if (!entry) return
      this._pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) {
        entry.reject(
          makeError(
            `CDP 调用失败：${entry.method}：${message.error.message || JSON.stringify(message.error)}`,
            'CDP_ERROR',
          ),
        )
      } else {
        entry.resolve(message.result || {})
      }
      return
    }
    if (!message.method) return
    const params = message.params || {}
    if (message.sessionId) {
      const page = this._sessions.get(message.sessionId)
      if (page) page._onEvent(message.method, params)
      return
    }
    if (message.method === 'Target.detachedFromTarget') {
      const page = this._sessions.get(params.sessionId)
      if (page) {
        page._markClosed()
        this._sessions.delete(params.sessionId)
        this._pages.delete(page)
      }
    } else if (message.method === 'Target.targetDestroyed') {
      for (const page of [...this._pages]) {
        if (page._targetId === params.targetId) {
          page._markClosed()
          this._pages.delete(page)
          this._sessions.delete(page._sessionId)
          break
        }
      }
    }
  }

  /**
   * 发送一条 CDP 命令。
   * @param {string} method
   * @param {object} [params]
   * @param {string} [sessionId] flat session 模式下的页面 session
   * @param {{timeoutMs?:number}} [options]
   */
  send(method, params = {}, sessionId, options = {}) {
    const timeoutMs = Number.isFinite(options && options.timeoutMs)
      ? options.timeoutMs
      : DEFAULT_CDP_TIMEOUT_MS
    if (this.closed) {
      return Promise.reject(makeError(`浏览器已关闭，无法执行 ${method}。`, 'CDP_ERROR'))
    }
    if (!this._ws || this._ws.readyState !== 1) {
      return Promise.reject(makeError(`浏览器调试连接不可用，无法执行 ${method}。`, 'CDP_ERROR'))
    }
    const id = ++this._nextId
    const payload = { id, method, params: params || {} }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      let timer = null
      timer = setTimeout(() => {
        if (this._pending.delete(id)) {
          reject(makeError(`浏览器操作超时：${method}（${timeoutMs}ms）`, 'CDP_TIMEOUT'))
        }
      }, Math.max(100, timeoutMs))
      if (timer && typeof timer.unref === 'function') timer.unref()
      this._pending.set(id, { method, sessionId, resolve, reject, timer })
      try {
        this._ws.send(JSON.stringify(payload))
      } catch (error) {
        this._pending.delete(id)
        clearTimeout(timer)
        reject(makeError(`发送 CDP 请求失败：${method}：${error.message}`, 'CDP_ERROR', error))
      }
    })
  }

  /** 新建页面（target）。url 给出时创建后立即导航。 */
  async newPage(url) {
    if (this.closed) throw makeError('浏览器已关闭，无法新建页面。', 'CDP_ERROR')
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' }, undefined, {
      timeoutMs: 15000,
    })
    const { sessionId } = await this.send(
      'Target.attachToTarget',
      { targetId, flatten: true },
      undefined,
      { timeoutMs: 15000 },
    )
    const page = new Page(this, targetId, sessionId)
    this._pages.add(page)
    this._sessions.set(sessionId, page)
    try {
      await page.send('Page.enable', {}, { timeoutMs: 10000 })
      await page.send('Runtime.enable', {}, { timeoutMs: 10000 })
      await page.send('Network.enable', {}, { timeoutMs: 10000 })
      const frameTree = await page.send('Page.getFrameTree', {}, { timeoutMs: 10000 })
      page._mainFrameId = frameTree?.frameTree?.frame?.id || null
      if (url) await page.goto(url)
    } catch (error) {
      try {
        await page.close()
      } catch {
        /* ignore */
      }
      throw error
    }
    return page
  }

  /** 浏览器的全部 cookie（含 HttpOnly）。 */
  async cookies() {
    const result = await this.send('Storage.getCookies', {}, undefined, { timeoutMs: 10000 })
    return Array.isArray(result && result.cookies) ? result.cookies : []
  }

  /** 浏览器版本信息（/json/version）。 */
  async version() {
    if (this._versionInfo) return { ...this._versionInfo }
    const response = await fetch(`http://127.0.0.1:${this.port}/json/version`, {
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) throw makeError(`读取浏览器版本失败：HTTP ${response.status}`, 'CDP_ERROR')
    const data = await response.json()
    this._versionInfo = data
    return { ...data }
  }

  async _doClose() {
    const child = this._child
    if (!this.closed) {
      try {
        await this.send('Browser.close', {}, undefined, { timeoutMs: 3000 })
      } catch {
        /* 浏览器可能已经在退出 */
      }
      await waitForChildExit(child, CHILD_EXIT_WAIT_MS)
    }
    this.closed = true
    try {
      this._ws.close()
    } catch {
      /* ignore */
    }
    if (child && child.exitCode === null && child.signalCode === null) {
      await killChildProcess(child)
    }
    this._rejectAll(makeError('浏览器已关闭。', 'CDP_ERROR'))
    this._pages.clear()
    this._sessions.clear()
  }

  /** 幂等关闭：CDP Browser.close -> 等待进程退出 -> kill 兜底。 */
  async close() {
    if (this._closePromise) return this._closePromise
    this._closePromise = this._doClose()
      .catch(() => {
        this.closed = true
      })
      .finally(() => {
        try {
          if (this._child) this._child.unref()
        } catch {
          /* ignore */
        }
      })
    return this._closePromise
  }
}

/** 一个页面（target + flat session）。 */
class Page {
  constructor(browser, targetId, sessionId) {
    this._browser = browser
    this._targetId = targetId
    this._sessionId = sessionId
    this._mainFrameId = null
    this._lastDocumentResponse = null
    this._lastDocumentError = null
    this._navCommitted = false
    this._loadFired = false
    this.closed = false
    this.crashed = false
  }

  _markClosed() {
    this.closed = true
  }

  _onEvent(method, params) {
    if (method === 'Network.responseReceived') {
      if (params.type === 'Document' && (!this._mainFrameId || params.frameId === this._mainFrameId)) {
        const response = params.response || {}
        this._lastDocumentResponse = { url: response.url || '', status: Number(response.status) || 0 }
      }
    } else if (method === 'Network.loadingFailed') {
      if (params.type === 'Document' && (!this._mainFrameId || params.frameId === this._mainFrameId)) {
        this._lastDocumentError = params.errorText || 'unknown'
      }
    } else if (method === 'Page.frameNavigated') {
      const frame = params.frame || {}
      // 只关心主框架提交（子 iframe 的 frameNavigated 不改变页面导航状态）。
      if (!frame.parentId && (!this._mainFrameId || frame.id === this._mainFrameId)) {
        this._navCommitted = true
      }
    } else if (method === 'Page.loadEventFired') {
      this._loadFired = true
    } else if (method === 'Inspector.targetCrashed') {
      this.crashed = true
      this.closed = true
    }
  }

  send(method, params = {}, options = {}) {
    if (this.closed) {
      return Promise.reject(makeError(`页面已关闭，无法执行 ${method}。`, 'CDP_ERROR'))
    }
    return this._browser.send(method, params, this._sessionId, options)
  }

  /**
   * 在页面里执行函数或表达式。
   * 函数会被序列化为 `(${fn})(${JSON.stringify(arg)})`，returnByValue + awaitPromise。
   */
  async evaluate(fnOrExpression, arg, options = {}) {
    if (this.closed) throw makeError('页面已关闭，无法执行页面脚本。', 'CDP_ERROR')
    let expression
    if (typeof fnOrExpression === 'function') {
      const argLiteral = arg === undefined ? 'undefined' : JSON.stringify(arg)
      expression = `(${fnOrExpression.toString()})(${argLiteral})`
    } else {
      expression = String(fnOrExpression)
    }
    const timeoutMs = Number.isFinite(options && options.timeoutMs)
      ? options.timeoutMs
      : DEFAULT_CDP_TIMEOUT_MS
    const result = await this.send(
      'Runtime.evaluate',
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      },
      { timeoutMs },
    )
    if (result && result.exceptionDetails) {
      const details = result.exceptionDetails
      const description =
        (details.exception && details.exception.description) || details.text || '页面脚本执行异常'
      throw makeError(
        `页面脚本执行异常：${String(description).split('\n').slice(0, 3).join(' ')}`,
        'CDP_ERROR',
      )
    }
    const remote = result && result.result
    if (!remote) return undefined
    if (remote.type === 'undefined') return undefined
    if (remote.subtype === 'error') {
      throw makeError(`页面脚本执行异常：${remote.description || 'error'}`, 'CDP_ERROR')
    }
    if (remote.unserializableValue !== undefined) {
      const literal = String(remote.unserializableValue)
      if (literal === 'NaN') return NaN
      if (literal === 'Infinity') return Infinity
      if (literal === '-Infinity') return -Infinity
      if (literal === '-0') return -0
      return Number(literal.replace(/n$/, ''))
    }
    return remote.value
  }

  /** 导航到 url，等待 document.readyState === 'complete'。返回最终 url/title/HTTP status。 */
  async goto(url, options = {}) {
    if (this.closed) throw makeError('页面已关闭，无法导航。', 'CDP_ERROR')
    const timeoutMs = Number.isFinite(options && options.timeoutMs) ? options.timeoutMs : 30000
    this._lastDocumentResponse = null
    this._lastDocumentError = null
    this._navCommitted = false
    this._loadFired = false
    const nav = await this.send('Page.navigate', { url }, {
      timeoutMs: Math.min(Math.max(5000, timeoutMs), 20000),
    })
    if (nav && nav.errorText) {
      throw makeError(`打开页面失败：${nav.errorText}（${url}）`, 'CDP_ERROR')
    }
    const deadline = Date.now() + Math.max(1000, timeoutMs)
    let ready = false
    while (Date.now() < deadline) {
      // 浏览器/页面已被关闭（用户关窗口、closeAll、进程退出）时立即报错，不要挂到超时。
      if (this.closed || (this._browser && this._browser.closed)) {
        throw makeError(`页面已关闭，导航失败：${url}`, 'CDP_ERROR')
      }
      // 必须等主框架真正提交新文档（避免慢响应时把旧文档的 readyState=complete 当成加载完成）。
      if (this._navCommitted) {
        if (this._loadFired) {
          ready = true
          break
        }
        try {
          const state = await this.evaluate('document.readyState')
          if (state === 'complete') {
            ready = true
            break
          }
        } catch (error) {
          if (this.closed) throw makeError(`页面已关闭，导航失败：${url}`, 'CDP_ERROR')
        }
      }
      await sleep(120)
    }
    if (!ready) {
      if (this._lastDocumentError) {
        throw makeError(`打开页面失败：${this._lastDocumentError}（${url}）`, 'CDP_ERROR')
      }
      throw makeError(`等待页面加载超时（${timeoutMs}ms）：${url}`, 'CDP_TIMEOUT')
    }
    let info = null
    try {
      info = await this.evaluate('({ url: String(location.href), title: String(document.title) })')
    } catch {
      /* 忽略标题读取失败 */
    }
    for (let i = 0; i < 10 && !this._lastDocumentResponse; i += 1) await sleep(50)
    return {
      url: (info && info.url) || url,
      title: (info && info.title) || '',
      status: this._lastDocumentResponse ? this._lastDocumentResponse.status : 0,
    }
  }

  /** 轮询页面条件直到 truthy；超时抛 CDP_TIMEOUT。 */
  async waitFor(fnOrExpression, options = {}) {
    const timeoutMs = Number.isFinite(options && options.timeoutMs) ? options.timeoutMs : 15000
    const intervalMs = Number.isFinite(options && options.intervalMs) ? options.intervalMs : 250
    const deadline = Date.now() + Math.max(250, timeoutMs)
    let lastError = null
    for (;;) {
      if (this.closed || (this._browser && this._browser.closed)) {
        throw makeError('页面已关闭。', 'CDP_ERROR')
      }
      try {
        const value = await this.evaluate(fnOrExpression)
        if (value) return value
      } catch (error) {
        if (this.closed || (this._browser && this._browser.closed)) {
          throw makeError('页面已关闭。', 'CDP_ERROR')
        }
        lastError = error
      }
      if (Date.now() + intervalMs > deadline) break
      await sleep(Math.max(50, intervalMs))
    }
    throw makeError(
      `等待页面条件超时（${timeoutMs}ms）${lastError ? `：${lastError.message}` : ''}`,
      'CDP_TIMEOUT',
    )
  }

  /** 页面截图，返回 base64 PNG。 */
  async screenshot() {
    const result = await this.send('Page.captureScreenshot', { format: 'png' }, { timeoutMs: 20000 })
    if (!result || !result.data) throw makeError('页面截图失败：未返回图像数据。', 'CDP_ERROR')
    return result.data
  }

  /** 关闭页面（关闭对应 target）；幂等。 */
  async close() {
    if (this.closed) return
    this.closed = true
    try {
      this._browser._pages.delete(this)
      this._browser._sessions.delete(this._sessionId)
    } catch {
      /* ignore */
    }
    try {
      await this._browser.send('Target.closeTarget', { targetId: this._targetId }, undefined, {
        timeoutMs: 3000,
      })
    } catch {
      /* ignore */
    }
  }
}
