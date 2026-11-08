// dev/test-browser.mjs
//
// 浏览器驱动自动化测试：真实 Microsoft Edge（CDP）+ 本地 node:http fixture 站点，零 npm 依赖。
//
// 覆盖：
//   1. cdp.js：启动 headless Edge、CDP 连接、goto/evaluate/waitFor/screenshot/cookies、幂等 close、进程退出。
//   2. extract.js：登录页（login）、真人验证页（captcha）、正文/链接/密码框提取、normalizeText。
//   3. browser.js：manager.login 自动填表登录成功 -> 会话保存（跨浏览器重启可复用）；
//      fetch 读取登录后文章；search 模板/猜测地址；challenge 交接（可见窗口 + pending + confirm/cancel）；
//      模拟真人在窗口内点击“人机验证”后自动检测成功并恢复 fetch；visible 账号使用 headed 浏览器；
//      closeAll / removeProfile 清理；无明文密码泄漏到日志。
//
// 运行：node dev/test-browser.mjs    （退出码 0 = 全部通过）
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startFixtureServer } from './fixture-server.mjs'
import { launchBrowser, findBrowserExecutable } from '../lib/cdp.js'
import { readPage, detectChallenge, normalizeText } from '../lib/extract.js'
import { createBrowserManager } from '../lib/browser.js'

// ---------------------------------------------------------------------------
// 测试基础设施
// ---------------------------------------------------------------------------

const results = []
const log = (...args) => console.log('[test]', ...args)

async function step(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`PASS  ${name}`)
  } catch (error) {
    results.push({ name, ok: false, error })
    console.error(`FAIL  ${name}`)
    console.error(error && error.stack ? error.stack : error)
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitUntil(fn, { timeoutMs = 30000, intervalMs = 250, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const value = await fn()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await sleep(intervalMs)
  }
  throw new Error(`等待超时（${timeoutMs}ms）：${label}${lastError ? `；最后错误：${lastError.message}` : ''}`)
}

function isProcessAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 假 store：只实现 browser.js 需要的 get / setSession，额外记录 setSession 调用用于安全断言。 */
function createFakeStore(accountList) {
  const accounts = new Map()
  const sessionWrites = []
  for (const item of accountList) {
    accounts.set(item.id, { session: { status: 'unknown' }, ...item })
  }
  return {
    _accounts: accounts,
    sessionWrites,
    sessionOf(id) {
      const account = accounts.get(id)
      return account ? account.session : null
    },
    async list() {
      return [...accounts.values()].map((account) => {
        const { password, ...pub } = account
        return pub
      })
    },
    async get(id) {
      const account = accounts.get(id)
      if (!account) return undefined
      return { ...account }
    },
    async create() {
      throw new Error('fake store: create 未实现')
    },
    async update() {
      throw new Error('fake store: update 未实现')
    },
    async remove() {
      throw new Error('fake store: remove 未实现')
    },
    async setSession(id, patch) {
      const account = accounts.get(id)
      if (!account) return undefined
      sessionWrites.push({ id, patch: { ...patch } })
      account.session = { ...(account.session || {}), ...patch }
      return account
    },
  }
}

// ---------------------------------------------------------------------------
// 全局状态
// ---------------------------------------------------------------------------

const workDir = await mkdtemp(join(tmpdir(), 'dsh-account-hub-browser-test-'))
const rawPids = []
const managerPids = []

let fixture = null
let fixtureAuto = null
let fixtureOauth = null
let rawBrowser = null
let manager = null
let store = null
let capturedLogs = []

const ACCOUNT_ID = 'acc_fixture000001'
const VISIBLE_ACCOUNT_ID = 'acc_visible000001'
const PASSKEY_ACCOUNT_ID = 'acc_passkey00001'
const SESSIONLIKE_ACCOUNT_ID = 'acc_sessionlike01'
const MANUAL_ACCOUNT_ID = 'acc_manual000001'
const MANUAL_AUTOCLICK_ACCOUNT_ID = 'acc_manualauto01'
const MANUAL_CONFIRM_ACCOUNT_ID = 'acc_manualconf01'
const AUTO_DISCOVER_ACCOUNT_ID = 'acc_autodisc0001'
const MANUAL_DISCOVER_ACCOUNT_ID = 'acc_manudisc0001'
const OAUTH_ACCOUNT_ID = 'acc_oauth0000001'
const PROBE_NEGATIVE_ACCOUNT_ID = 'acc_probeneg0001'

try {
  log('node', process.version)
  log('workDir', workDir)
  fixture = await startFixtureServer()
  log('fixture server:', fixture.url)
  // 第二个 fixture（同代码，autologin 开关）：根页会下发 cookie，/login 会模拟“用户手动提交”，
  // 用于验证 loginUrl 为空时从营销首页自动发现登录页 + 用户完成登录。
  fixtureAuto = await startFixtureServer({ autologin: true })
  log('fixture server (autologin):', fixtureAuto.url)
  // 第三个 fixture（另一个端口/origin）：扮演第三方 OAuth 授权域（模拟 accounts.google.com）。
  fixtureOauth = await startFixtureServer({ oauthProvider: true })
  log('fixture server (oauth provider):', fixtureOauth.url)
  const executablePath = findBrowserExecutable()
  log('browser executable:', executablePath)

  const account = {
    id: ACCOUNT_ID,
    label: 'Fixture 站点',
    url: `${fixture.url}/`,
    loginUrl: `${fixture.url}/login`,
    searchUrl: `${fixture.url}/search?q={query}`,
    username: 'fixture',
    password: 'fixture-pass',
    notes: '测试账号',
    visible: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    session: { status: 'unknown' },
  }
  const visibleAccount = {
    ...account,
    id: VISIBLE_ACCOUNT_ID,
    label: '可见窗口站点',
    searchUrl: '',
    visible: true,
  }
  // passkey-only 账号：密码登录被拒绝（模拟 GitHub passkey-only 账号，修复误判用）。
  const passkeyAccount = {
    ...account,
    id: PASSKEY_ACCOUNT_ID,
    label: 'Passkey-only 站点',
    url: `${fixture.url}/article`,
    loginUrl: `${fixture.url}/login/passkey`,
    searchUrl: '',
    username: 'passkey-user',
    password: 'ignored-pass',
  }
  // 假成功页账号：登录失败但 302 到 /session（登录类路径），旧逻辑会误判成功。
  const sessionlikeAccount = {
    ...account,
    id: SESSIONLIKE_ACCOUNT_ID,
    label: '假成功页站点',
    url: `${fixture.url}/article`,
    loginUrl: `${fixture.url}/login/sessionlike`,
    searchUrl: '',
    username: 'session-user',
    password: 'ignored-pass',
  }
  // loginMode='manual'（模拟 Google / passkey 账号）：只开窗口、不自动填表。
  const manualAccount = {
    ...account,
    id: MANUAL_ACCOUNT_ID,
    label: '手动登录站点',
    url: `${fixture.url}/article`,
    loginUrl: `${fixture.url}/manual-login`,
    searchUrl: '',
    username: 'google-user',
    password: 'ignored-pass',
    loginMode: 'manual',
  }
  const manualAutoclickAccount = {
    ...manualAccount,
    id: MANUAL_AUTOCLICK_ACCOUNT_ID,
    label: '手动登录站点（模拟用户完成）',
    loginUrl: `${fixture.url}/manual-login?autoclick=1&delay=2500`,
  }
  const manualConfirmAccount = {
    ...manualAccount,
    id: MANUAL_CONFIRM_ACCOUNT_ID,
    label: '手动登录站点（confirm 路径）',
    // 第三方登录完成后停在“正在返回”页：自动成功检测拿不到强证据，只能靠用户确认。
    loginUrl: `${fixture.url}/manual-login?autoclick=1&target=third-party-return&delay=2500`,
  }
  // loginUrl 为空 + auto：从营销首页自动发现 /login 后自动填表登录。
  const autoDiscoverAccount = {
    ...account,
    id: AUTO_DISCOVER_ACCOUNT_ID,
    label: '自动发现登录页站点（auto）',
    url: `${fixture.url}/`,
    loginUrl: '',
    searchUrl: '',
  }
  // loginUrl 为空 + manual：营销首页 -> 自动发现 /login；第二个 fixture 会模拟用户手动完成登录。
  const manualDiscoverAccount = {
    ...manualAccount,
    id: MANUAL_DISCOVER_ACCOUNT_ID,
    label: '自动发现登录页站点（manual）',
    url: `${fixtureAuto.url}/`,
    loginUrl: '',
    searchUrl: '',
  }
  // 第三方 OAuth 登录账号：站点入口 -> 另一个 origin 的 OAuth 授权页 -> 回调 /account。
  const oauthAccount = {
    ...manualAccount,
    id: OAUTH_ACCOUNT_ID,
    label: '第三方 OAuth 登录站点',
    url: `${fixture.url}/`,
    loginUrl:
      `${fixture.url}/start-google-login?oauth=${encodeURIComponent(fixtureOauth.url)}` +
      '&autoclick=1&delay=800&oauthdelay=6000',
    searchUrl: '',
  }
  // 会话未建立时探测会拿到登录页：页面同源、无密码框/挑战，但 probe 明确显示未登录。
  const probeNegativeAccount = {
    ...manualAccount,
    id: PROBE_NEGATIVE_ACCOUNT_ID,
    label: '登录页探测站点',
    url: `${fixture.url}/login`,
    loginUrl: `${fixture.url}/third-party-return`,
    searchUrl: '',
  }
  store = createFakeStore([
    account,
    visibleAccount,
    passkeyAccount,
    sessionlikeAccount,
    manualAccount,
    manualAutoclickAccount,
    manualConfirmAccount,
    autoDiscoverAccount,
    manualDiscoverAccount,
    oauthAccount,
    probeNegativeAccount,
  ])

  const profilesDir = join(workDir, 'profiles')
  capturedLogs = []
  manager = createBrowserManager({
    store,
    profilesDir,
    config: {
      browserPath: executablePath,
      loginTimeoutMs: 60000,
      pageTimeoutMs: 25000,
      maxTextChars: 20000,
      autoOpenOnChallenge: true,
      pollIntervalMs: 400,
    },
    log: (...args) => {
      const line = args.map((item) => (typeof item === 'string' ? item : String(item))).join(' ')
      capturedLogs.push(line)
      log('(manager)', line)
    },
  })

  // =========================================================================
  // 1. cdp.js + extract.js
  // =========================================================================

  await step('cdp: 启动 headless Edge 并建立 CDP 连接', async () => {
    rawBrowser = await launchBrowser({
      headed: false,
      profileDir: join(workDir, 'raw-profile'),
      executablePath,
      timeoutMs: 40000,
    })
    rawPids.push(rawBrowser.pid)
    assert.ok(rawBrowser.pid > 0, '浏览器 pid 应为正数')
    assert.ok(rawBrowser.port > 0, '调试端口应为正数')
    assert.equal(rawBrowser.closed, false)
    const version = await rawBrowser.version()
    assert.ok(version && typeof version.Browser === 'string', 'version() 应返回 Browser 字段')
    assert.match(version.Browser, /Edg|Chrome/i)
  })

  await step('extract: 登录页 challenge=login，正文/链接/密码框正确', async () => {
    const page = await rawBrowser.newPage()
    const nav = await page.goto(`${fixture.url}/login`)
    assert.ok(nav.url.endsWith('/login'), `goto 返回最终 url 应为 /login，实际 ${nav.url}`)
    assert.equal(nav.status, 200, `HTTP status 应为 200，实际 ${nav.status}`)
    const info = await readPage(page)
    assert.equal(info.hasPasswordField, true, '登录页应检测到可见密码框')
    assert.equal(info.hasLoginForm, true, '登录页应检测到登录表单')
    assert.equal(info.challenge.kind, 'login', `登录页 challenge 应为 login，实际 ${info.challenge.kind}`)
    assert.match(info.text, /账号登录|Sign in/, '正文应包含登录文案')
    assert.ok(!info.text.includes('Fixture footer'), '正文应剔除 footer 文本')
    assert.ok(
      info.links.some((link) => link.url.endsWith('/article') && /文章/.test(link.text)),
      '链接应包含绝对地址的 /article',
    )
  })

  await step('extract: /challenge 判定为 captcha', async () => {
    const page = await rawBrowser.newPage()
    await page.goto(`${fixture.url}/challenge`)
    const challenge = await detectChallenge(page)
    assert.equal(challenge.kind, 'captcha', `challenge 页应判定 captcha，实际 ${challenge.kind}`)
    assert.ok(challenge.evidence.length > 0, 'evidence 应为非空字符串')
    const info = await readPage(page)
    assert.equal(info.challenge.kind, 'captcha')
    assert.equal(info.hasPasswordField, false, 'challenge 页不应有密码框')
  })

  await step('cdp: evaluate / waitFor / screenshot / cookies / page.close', async () => {
    const page = await rawBrowser.newPage()
    await page.goto(`${fixture.url}/`)
    assert.equal(await page.evaluate('1 + 1'), 2)
    assert.equal(await page.evaluate((value) => value * 3, 7), 21)
    const ready = await page.waitFor(() => document.readyState === 'complete', { timeoutMs: 5000 })
    assert.equal(ready, true)
    const shot = await page.screenshot()
    assert.ok(typeof shot === 'string' && shot.length > 1000, '截图应为非空 base64')
    const cookies = await rawBrowser.cookies()
    assert.ok(Array.isArray(cookies), 'cookies() 应返回数组')
    await page.close()
    await assert.rejects(() => page.evaluate('1'), /页面已关闭/, '关闭后的页面调用应报错')
  })

  await step('extract: /article 未登录被 302 到 /login', async () => {
    const page = await rawBrowser.newPage()
    const nav = await page.goto(`${fixture.url}/article`)
    assert.ok(nav.url.endsWith('/login'), `未登录 /article 应跳到 /login，实际 ${nav.url}`)
    const info = await readPage(page)
    assert.equal(info.challenge.kind, 'login')
  })

  await step('extract: normalizeText 折叠空白并截断', async () => {
    assert.equal(normalizeText('  a \n\n  b\t c  '), 'a b c')
    assert.equal(normalizeText('abcdef', 3), 'abc')
  })

  await step('cdp: close 幂等且浏览器进程退出', async () => {
    const pid = rawBrowser.pid
    await rawBrowser.close()
    assert.equal(rawBrowser.closed, true, 'close 后 closed 应为 true')
    await rawBrowser.close() // 幂等
    await sleep(500)
    assert.equal(isProcessAlive(pid), false, `浏览器进程 ${pid} 应已退出`)
    await assert.rejects(() => rawBrowser.send('Page.navigate', {}), /已关闭/, '关闭后 send 应报错')
    rawBrowser = null
  })

  // =========================================================================
  // 2. browser.js：manager 基础 + 登录
  // =========================================================================

  await step('manager: available()/profilesDir/pending() 初始状态', async () => {
    const availability = manager.available()
    assert.equal(availability.browserAvailable, true, '浏览器应可用')
    assert.ok(availability.executablePath, 'available() 应带 executablePath')
    assert.equal(manager.profilesDir, profilesDir, 'profilesDir 属性应等于构造参数')
    assert.equal(manager.pending(), null, '初始 pending 应为 null')
    assert.equal(manager.isBusy(ACCOUNT_ID), false)
    assert.deepEqual(manager.debugState().browsers, [])
  })

  await step('manager: login 自动填表 -> 会话 authenticated（窗口自动关闭）', async () => {
    const loginResult = await manager.login(ACCOUNT_ID)
    assert.equal(loginResult.status, 'started', `login 应返回 started：${JSON.stringify(loginResult)}`)
    assert.ok(loginResult.pending, 'login 应返回 pending')
    assert.equal(loginResult.pending.phase, 'logging-in')
    assert.ok(loginResult.pending.hint && /浏览器|登录/.test(loginResult.pending.hint), 'hint 应为中文提示')
    assert.equal(manager.isBusy(ACCOUNT_ID), true, '登录中应 busy')
    const busyResult = await manager.login(ACCOUNT_ID)
    assert.equal(busyResult.status, 'busy', '重复 login 应返回 busy')

    await waitUntil(() => store.sessionOf(ACCOUNT_ID).status === 'authenticated', {
      timeoutMs: 45000,
      label: '自动填表登录成功',
    })
    await waitUntil(() => manager.pending() === null, { timeoutMs: 20000, label: '登录完成后 pending 清空' })
    await waitUntil(() => manager.debugState().browsers.length === 0, {
      timeoutMs: 20000,
      label: '登录窗口关闭',
    })
    assert.equal(manager.isBusy(ACCOUNT_ID), false, '登录结束后 busy 应清除')
    assert.equal(store.sessionWrites.some((w) => w.patch.lastLoginAt), true, '应写入 lastLoginAt')
    managerPids.push(...manager.debugState().launchedPids)
  })

  await step('manager: loginUrl 为空时自动发现 /login 并自动填表登录（auto）', async () => {
    // 账号 url 是营销首页（无登录表单），loginUrl 为空：应自动探测到 /login 再自动填表。
    const loginResult = await manager.login(AUTO_DISCOVER_ACCOUNT_ID)
    assert.equal(loginResult.status, 'started', `login 应返回 started：${JSON.stringify(loginResult)}`)
    const discovered = await waitUntil(
      () => {
        const item = manager.pendingFor(AUTO_DISCOVER_ACCOUNT_ID)
        return item && /\/login$/.test(item.url || '') ? item : null
      },
      { timeoutMs: 25000, label: 'auto 模式自动发现 /login' },
    )
    assert.match(discovered.url, /\/login$/, `窗口应自动导航到 /login，实际 ${discovered.url}`)
    await waitUntil(() => store.sessionOf(AUTO_DISCOVER_ACCOUNT_ID).status === 'authenticated', {
      timeoutMs: 45000,
      label: '自动发现登录页后自动填表登录成功',
    })
    await waitUntil(() => manager.pendingFor(AUTO_DISCOVER_ACCOUNT_ID) === null, {
      timeoutMs: 20000,
      label: 'auto 发现流程 pending 清空',
    })
    await waitUntil(() => manager.debugState().browsers.length === 0, {
      timeoutMs: 20000,
      label: 'auto 发现流程窗口关闭',
    })
    const record = await store.get(AUTO_DISCOVER_ACCOUNT_ID)
    const article = await manager.fetch(record, `${fixture.url}/article`)
    assert.equal(article.status, 'ok', `自动发现并登录后 fetch 应成功：${JSON.stringify(article)}`)
    assert.match(article.text, /Fixture 文章正文/)
  })

  await step('manager: fetch /article 复用已保存会话（跨浏览器重启）', async () => {
    const result = await manager.fetch(account, `${fixture.url}/article`)
    assert.equal(result.status, 'ok', `fetch 应成功：${JSON.stringify(result)}`)
    assert.match(result.text, /Fixture 文章正文/, '正文应包含文章内容')
    assert.match(result.text, /量子计算/, '正文应包含主题词')
    assert.equal(result.challenge, null, '成功时 challenge 应为 null')
    assert.ok(
      result.links.some((link) => link.url.includes('/article?page=2')),
      '应返回页面链接',
    )
    assert.equal(store.sessionOf(ACCOUNT_ID).status, 'authenticated')
  })

  await step('manager: search 使用 searchUrl 模板 / 无模板时猜测地址', async () => {
    const result = await manager.search(account, '量子 计算')
    assert.equal(result.status, 'ok', `search 应成功：${JSON.stringify(result)}`)
    assert.equal(result.usedUrl, `${fixture.url}/search?q=${encodeURIComponent('量子 计算')}`)
    assert.match(result.text, /量子 计算/, '搜索结果正文应回显关键词')

    const guessed = await manager.search({ ...account, searchUrl: '' }, 'harness')
    assert.equal(guessed.status, 'ok')
    assert.equal(guessed.usedUrl, `${new URL(fixture.url).origin}/search?q=harness`)
    assert.equal(guessed.guessed, true, '无模板时应标记 guessed:true')
  })

  // =========================================================================
  // 3. browser.js：真人验证交接
  // =========================================================================

  await step('manager: fetch challenge -> verification-required + pending；confirm 仍 required；cancel 清理', async () => {
    const result = await manager.fetch(account, `${fixture.url}/challenge`)
    assert.equal(result.status, 'verification-required', `应返回 verification-required：${JSON.stringify(result)}`)
    assert.ok(result.pending, '应返回 pending')
    assert.equal(result.challenge.kind, 'captcha', `challenge.kind 应为 captcha，实际 ${result.challenge && result.challenge.kind}`)
    assert.ok(result.hint && /验证/.test(result.hint), 'hint 应提示用户完成验证')
    assert.ok(manager.pending(), 'manager.pending() 应非空')
    assert.equal(manager.pending().accountId, ACCOUNT_ID)
    await waitUntil(() => store.sessionOf(ACCOUNT_ID).status === 'verification-required', {
      timeoutMs: 10000,
      label: '会话状态标记 verification-required',
    })

    const confirmResult = await manager.confirm(ACCOUNT_ID)
    assert.equal(confirmResult.status, 'still-required', `确认时页面仍是挑战页，应返回 still-required：${JSON.stringify(confirmResult)}`)
    assert.ok(manager.pending(), 'still-required 时应保留 pending')

    const cancelResult = await manager.cancel(ACCOUNT_ID)
    assert.equal(cancelResult.status, 'cancelled')
    assert.equal(manager.pending(), null, 'cancel 后 pending 应为 null')
    await waitUntil(() => manager.debugState().browsers.length === 0, {
      timeoutMs: 15000,
      label: 'cancel 后可见窗口关闭',
    })
    await waitUntil(() => store.sessionOf(ACCOUNT_ID).status === 'unknown', {
      timeoutMs: 10000,
      label: 'cancel 后会话状态 unknown',
    })
  })

  await step('manager: challenge 交接 -> 模拟真人在窗口内点击验证 -> 自动检测成功 -> fetch 恢复', async () => {
    // 延迟 4s 再模拟点击：确保 headless fetch（加载后约 2s 读取）先检测到 captcha 并完成交接，
    // 而不是在 headless 阶段就被“点掉”。验证按钮实际是在 manager 打开的可见窗口里被点击的。
    const result = await manager.fetch(account, `${fixture.url}/challenge?autoclick=1&delay=4000`)
    assert.equal(result.status, 'verification-required', `应返回 verification-required：${JSON.stringify(result)}`)
    assert.ok(result.pending, '应返回 pending（可见窗口已打开）')
    assert.equal(result.pending.phase, 'verification-required')
    await waitUntil(() => store.sessionOf(ACCOUNT_ID).status === 'verification-required', {
      timeoutMs: 10000,
      label: '会话标记 verification-required',
    })

    // fixture 页面中的“人机验证”按钮会在 1.5s 后自动点击（模拟真人操作），
    // 随后服务端下发 cookie 并跳转 /account；manager 的轮询应检测到登录成功。
    await waitUntil(() => manager.pending() === null, {
      timeoutMs: 45000,
      label: '真人点击验证后自动检测成功并清空 pending',
    })
    assert.equal(store.sessionOf(ACCOUNT_ID).status, 'authenticated', '验证完成后会话应为 authenticated')
    await waitUntil(() => manager.debugState().browsers.length === 0, {
      timeoutMs: 15000,
      label: '验证完成后窗口关闭',
    })

    const article = await manager.fetch(account, `${fixture.url}/article`)
    assert.equal(article.status, 'ok', `验证后 fetch 应成功：${JSON.stringify(article)}`)
    assert.match(article.text, /Fixture 文章正文/)
  })

  // =========================================================================
  // 4. browser.js：登录成功误判加固（passkey-only / 假成功页 /session）
  // =========================================================================

  await step('manager: passkey-only 账号登录不得误判 authenticated（保持窗口 + pending）', async () => {
    const loginResult = await manager.login(PASSKEY_ACCOUNT_ID)
    assert.equal(loginResult.status, 'started', `login 应返回 started：${JSON.stringify(loginResult)}`)
    // 密码登录被拒后应识别出 passkey-only 提示，进入待用户手动完成的状态。
    await waitUntil(
      () => {
        const item = manager.pendingFor(PASSKEY_ACCOUNT_ID)
        return !!(item && item.phase === 'verification-required')
      },
      { timeoutMs: 30000, label: 'passkey 页面进入 verification-required' },
    )
    // 再多等 3 个轮询周期（≥4s）：旧逻辑约 2.5s 就会误判 authenticated 并自动关窗。
    await sleep(Math.max(4000, 400 * 3))
    const session = store.sessionOf(PASSKEY_ACCOUNT_ID)
    assert.equal(
      session.status,
      'verification-required',
      `passkey-only 账号必须保持 verification-required，绝不能误判 authenticated（实际 ${session.status}）`,
    )
    const pending = manager.pendingFor(PASSKEY_ACCOUNT_ID)
    assert.ok(pending, 'passkey-only 账号的可见窗口必须保持打开（pending 存在）')
    assert.equal(pending.phase, 'verification-required')
    assert.match(pending.hint || '', /通行密钥|passkey|不支持密码/i, `hint 应说明通行密钥：${pending.hint}`)
    assert.ok(
      manager.debugState().active.some((item) => item.accountId === PASSKEY_ACCOUNT_ID && !item.closed),
      'passkey-only 账号的可见浏览器窗口应保持打开',
    )
    // 页面仍显示“不支持密码登录”时点“我已完成验证”不能算成功。
    const confirmResult = await manager.confirm(PASSKEY_ACCOUNT_ID)
    assert.equal(confirmResult.status, 'still-required', `confirm 应返回 still-required：${JSON.stringify(confirmResult)}`)
    assert.ok(manager.pendingFor(PASSKEY_ACCOUNT_ID), 'confirm 后 pending 应保留')
    // 清理
    const cancelResult = await manager.cancel(PASSKEY_ACCOUNT_ID)
    assert.equal(cancelResult.status, 'cancelled')
    assert.equal(manager.pendingFor(PASSKEY_ACCOUNT_ID), null)
    await waitUntil(() => manager.debugState().browsers.length === 0, {
      timeoutMs: 15000,
      label: 'passkey 验证窗口关闭',
    })
  })

  await step('manager: 疑似假成功页（/session 路径、无登出提示）不得自动判定 authenticated', async () => {
    const loginResult = await manager.login(SESSIONLIKE_ACCOUNT_ID)
    assert.equal(loginResult.status, 'started', `login 应返回 started：${JSON.stringify(loginResult)}`)
    // 旧逻辑会因“URL 变为 /session + cookie 集变化”误判成功；新逻辑必须停在 pending 等用户确认。
    await waitUntil(
      () => {
        const item = manager.pendingFor(SESSIONLIKE_ACCOUNT_ID)
        return !!(item && item.phase === 'verification-required')
      },
      { timeoutMs: 30000, label: '假成功页转入人工确认' },
    )
    await sleep(2500) // 再观察 2 个轮询周期，确认不会晚一步翻成 authenticated
    const session = store.sessionOf(SESSIONLIKE_ACCOUNT_ID)
    assert.notEqual(
      session.status,
      'authenticated',
      '停在 /session 且无登出提示的页面不得自动判定 authenticated',
    )
    assert.ok(manager.pendingFor(SESSIONLIKE_ACCOUNT_ID), '假成功页应保持可见窗口 + pending')
    const cancelResult = await manager.cancel(SESSIONLIKE_ACCOUNT_ID)
    assert.equal(cancelResult.status, 'cancelled')
    await waitUntil(() => manager.debugState().browsers.length === 0, {
      timeoutMs: 15000,
      label: '假成功页窗口关闭',
    })
  })

  // =========================================================================
  // 5. browser.js：loginMode='manual' 手动登录模式（Google / passkey 账号）
  // =========================================================================

  await step('manager: loginMode=manual 只开窗口不填表，进入 pending verification-required', async () => {
    const loginResult = await manager.login(MANUAL_ACCOUNT_ID)
    assert.equal(loginResult.status, 'started', `login 应返回 started：${JSON.stringify(loginResult)}`)
    assert.equal(loginResult.loginMode, 'manual', `应返回 loginMode=manual：${JSON.stringify(loginResult)}`)
    assert.ok(loginResult.pending, 'login 应返回 pending')
    assert.equal(
      loginResult.pending.phase,
      'verification-required',
      `manual 模式 pending.phase 应为 verification-required：${JSON.stringify(loginResult.pending)}`,
    )
    assert.match(
      loginResult.hint || '',
      /Google|手动|通行密钥|passkey/i,
      `manual hint 应说明手动完成方式：${loginResult.hint}`,
    )
    // 等页面加载完成（若发生自动填表，此刻字段应已有值）。
    await waitUntil(() => store.sessionOf(MANUAL_ACCOUNT_ID).status === 'verification-required', {
      timeoutMs: 15000,
      label: 'manual 会话标记 verification-required',
    })
    await sleep(2500)
    const dbg = await manager.debugPendingPage(MANUAL_ACCOUNT_ID)
    assert.ok(dbg, 'manual 模式应有保持打开的 pending 页面')
    assert.equal(dbg.loginMode, 'manual')
    assert.equal(dbg.phase, 'verification-required')
    assert.match(dbg.url || '', /\/manual-login/, `窗口应停在手动登录页，实际 ${dbg.url}`)
    assert.equal(dbg.hasPasswordField, true, '夹具手动登录页应有密码输入框（用于断言未被自动填写）')
    assert.ok(dbg.fields, '应能读取表单状态')
    assert.equal(dbg.fields.usernameFilled, false, 'manual 模式不得自动填写用户名')
    assert.equal(dbg.fields.passwordFilled, false, 'manual 模式不得自动填写密码')
    assert.ok(manager.pendingFor(MANUAL_ACCOUNT_ID), 'manual 模式窗口与 pending 应保持打开')
    // 页面仍停在同一 URL 且没有成功证据：窗口不应被自动关闭（已由上面 pending 断言覆盖）。
    const cancelResult = await manager.cancel(MANUAL_ACCOUNT_ID)
    assert.equal(cancelResult.status, 'cancelled')
    assert.equal(manager.pendingFor(MANUAL_ACCOUNT_ID), null)
    await waitUntil(() => manager.debugState().browsers.length === 0, {
      timeoutMs: 15000,
      label: 'manual 窗口关闭',
    })
  })

  await step('manager: manual + 用户在窗口内完成登录 -> 自动检测成功并关窗', async () => {
    const loginResult = await manager.login(MANUAL_AUTOCLICK_ACCOUNT_ID)
    assert.equal(loginResult.status, 'started', `login 应返回 started：${JSON.stringify(loginResult)}`)
    assert.equal(loginResult.loginMode, 'manual')
    // 夹具在 2.5s 后自动点击“使用 Google 登录”（模拟真人操作）-> cookie + /account。
    await waitUntil(() => manager.pendingFor(MANUAL_AUTOCLICK_ACCOUNT_ID) === null, {
      timeoutMs: 45000,
      label: 'manual 模式用户完成后自动检测成功',
    })
    assert.equal(
      store.sessionOf(MANUAL_AUTOCLICK_ACCOUNT_ID).status,
      'authenticated',
      '用户手动完成后应保存 authenticated',
    )
    await waitUntil(() => manager.debugState().browsers.length === 0, {
      timeoutMs: 15000,
      label: 'manual 成功后自动关窗',
    })
    const record = await store.get(MANUAL_AUTOCLICK_ACCOUNT_ID)
    const article = await manager.fetch(record, `${fixture.url}/article`)
    assert.equal(article.status, 'ok', `手动登录完成后 fetch 应成功：${JSON.stringify(article)}`)
    assert.match(article.text, /Fixture 文章正文/)
  })

  await step('manager: manual + 用户点“我已完成验证”（confirm 信任路径）保存会话并关窗', async () => {
    const loginResult = await manager.login(MANUAL_CONFIRM_ACCOUNT_ID)
    assert.equal(loginResult.status, 'started', `login 应返回 started：${JSON.stringify(loginResult)}`)
    assert.equal(loginResult.loginMode, 'manual')
    // 夹具 2.5s 后自动点击“使用 Google 登录”（模拟真人完成），随后停在 /third-party-return
    // —— 该页面没有登出/账号文案、也不在登录类路径，自动检测拿不到成功证据。
    const dbg = await waitUntil(
      async () => {
        const pageState = await manager.debugPendingPage(MANUAL_CONFIRM_ACCOUNT_ID)
        if (pageState && /\/session\/third-party-return/.test(pageState.url || '')) return pageState
        return null
      },
      { timeoutMs: 25000, label: '用户完成第三方登录后到达返回页' },
    )
    assert.equal(dbg.challenge.kind, 'none', `返回页不应被判定为验证码/登录页：${JSON.stringify(dbg.challenge)}`)
    // 再等 2s：自动检测应保持 pending（无法拿到强证据），而不是提前标记 authenticated/关窗。
    await sleep(2000)
    assert.notEqual(
      store.sessionOf(MANUAL_CONFIRM_ACCOUNT_ID).status,
      'authenticated',
      '无法自动确认时不得提前标记 authenticated（应等用户确认）',
    )
    assert.ok(manager.pendingFor(MANUAL_CONFIRM_ACCOUNT_ID), 'confirm 前窗口与 pending 应保持打开')
    // 用户点“我已完成验证”：confirm 检测不到成功也信任用户确认保存。
    const confirmResult = await manager.confirm(MANUAL_CONFIRM_ACCOUNT_ID)
    assert.equal(confirmResult.status, 'authenticated', `confirm 应信任用户确认：${JSON.stringify(confirmResult)}`)
    assert.equal(
      store.sessionOf(MANUAL_CONFIRM_ACCOUNT_ID).status,
      'authenticated',
      'confirm 后会话应为 authenticated',
    )
    assert.equal(manager.pendingFor(MANUAL_CONFIRM_ACCOUNT_ID), null, 'confirm 后 pending 应清空')
    await waitUntil(() => manager.debugState().browsers.length === 0, {
      timeoutMs: 15000,
      label: 'confirm 后窗口关闭',
    })
  })

  await step('manager: manual + loginUrl 为空时自动发现登录页（营销首页 -> /login）', async () => {
    const loginResult = await manager.login(MANUAL_DISCOVER_ACCOUNT_ID)
    assert.equal(loginResult.status, 'started', `login 应返回 started：${JSON.stringify(loginResult)}`)
    assert.equal(loginResult.loginMode, 'manual')
    // 从“营销首页”自动发现 /login：pending.url 应被更新为真实登录页。
    const discovered = await waitUntil(
      () => {
        const item = manager.pendingFor(MANUAL_DISCOVER_ACCOUNT_ID)
        return item && /\/login$/.test(item.url || '') ? item : null
      },
      { timeoutMs: 25000, label: 'manual 模式自动发现 /login' },
    )
    assert.match(discovered.url, /\/login$/, `窗口应自动导航到 /login，实际 ${discovered.url}`)
    assert.equal(discovered.phase, 'verification-required', 'manual 模式 pending 应保持 verification-required')
    // 第二个 fixture 根页下发了 fixture_autologin cookie，/login 会在 1.5s 后模拟“用户手动完成登录”。
    await waitUntil(() => store.sessionOf(MANUAL_DISCOVER_ACCOUNT_ID).status === 'authenticated', {
      timeoutMs: 45000,
      label: '模拟用户手动完成后 authenticated',
    })
    await waitUntil(() => manager.pendingFor(MANUAL_DISCOVER_ACCOUNT_ID) === null, {
      timeoutMs: 20000,
      label: 'manual 发现流程 pending 清空',
    })
    await waitUntil(() => manager.debugState().browsers.length === 0, {
      timeoutMs: 20000,
      label: 'manual 发现流程窗口关闭',
    })
  })

  // =========================================================================
  // 6. browser.js：同源门控 + 确定性会话探测（第三方 OAuth 误判修复）
  // =========================================================================

  await step('manager: 第三方 OAuth 页面期间绝不 authenticated/不关窗，回跳后才成功', async () => {
    const loginResult = await manager.login(OAUTH_ACCOUNT_ID)
    assert.equal(loginResult.status, 'started', `login 应返回 started：${JSON.stringify(loginResult)}`)
    assert.equal(loginResult.loginMode, 'manual')
    const thirdHost = new URL(fixtureOauth.url).host
    // 等窗口跳到第三方 OAuth origin（另一个端口）。
    const onThirdParty = await waitUntil(
      async () => {
        const pageState = await manager.debugPendingPage(OAUTH_ACCOUNT_ID)
        if (pageState && String(pageState.url || '').includes(thirdHost)) return pageState
        return null
      },
      { timeoutMs: 25000, label: '窗口跳到第三方 OAuth 页' },
    )
    assert.ok(onThirdParty, '应到达第三方 OAuth 页')
    assert.notEqual(
      store.sessionOf(OAUTH_ACCOUNT_ID).status,
      'authenticated',
      '到达第三方页时不得标记 authenticated',
    )
    assert.ok(manager.pendingFor(OAUTH_ACCOUNT_ID), '第三方页期间窗口必须保持打开（pending 存在）')
    // 在第三方页停留 ≥3 个轮询周期：绝不误判 authenticated、绝不关窗。
    await sleep(2500)
    assert.notEqual(
      store.sessionOf(OAUTH_ACCOUNT_ID).status,
      'authenticated',
      '第三方页停留期间不得误判 authenticated',
    )
    const pendingDuring = manager.pendingFor(OAUTH_ACCOUNT_ID)
    assert.ok(pendingDuring, '第三方页停留期间不得关闭窗口')
    assert.equal(
      pendingDuring.phase,
      'verification-required',
      `第三方页 pending 应为 verification-required：${JSON.stringify(pendingDuring)}`,
    )
    assert.match(
      pendingDuring.hint || '',
      /第三方|授权|完成后/,
      `第三方页 hint 应提示完成授权：${pendingDuring.hint}`,
    )
    // 第三方页约 6s 后自动回跳站点 /oauth/callback -> /account，这时才允许成功。
    await waitUntil(() => store.sessionOf(OAUTH_ACCOUNT_ID).status === 'authenticated', {
      timeoutMs: 45000,
      label: '回跳账号站点后 authenticated',
    })
    await waitUntil(() => manager.pendingFor(OAUTH_ACCOUNT_ID) === null, {
      timeoutMs: 20000,
      label: 'OAuth 成功后 pending 清空',
    })
    await waitUntil(() => manager.debugState().browsers.length === 0, {
      timeoutMs: 20000,
      label: 'OAuth 成功后窗口关闭',
    })
  })

  await step('manager: 会话未建立时确定性探测返回登录页 -> 不判成功', async () => {
    const loginResult = await manager.login(PROBE_NEGATIVE_ACCOUNT_ID)
    assert.equal(loginResult.status, 'started', `login 应返回 started：${JSON.stringify(loginResult)}`)
    // 页面同源、无密码框/无挑战，但 probe(account.url=/login) 返回登录页 -> 探测明确未登录。
    await waitUntil(
      () => {
        const item = manager.pendingFor(PROBE_NEGATIVE_ACCOUNT_ID)
        return item && item.phase === 'verification-required' ? item : null
      },
      { timeoutMs: 30000, label: '确定性探测未通过后转 verification-required' },
    )
    await sleep(2000) // 再多等几轮轮询，确认不会晚一步误判成功
    assert.notEqual(
      store.sessionOf(PROBE_NEGATIVE_ACCOUNT_ID).status,
      'authenticated',
      '探测返回登录页时不得误判 authenticated',
    )
    assert.ok(manager.pendingFor(PROBE_NEGATIVE_ACCOUNT_ID), '探测未通过时窗口应保持打开')
    // 用户点“我已完成验证”：探测仍明确显示未登录 -> confirm 应返回 still-required。
    const confirmResult = await manager.confirm(PROBE_NEGATIVE_ACCOUNT_ID)
    assert.equal(
      confirmResult.status,
      'still-required',
      `探测明确未登录时 confirm 应 still-required：${JSON.stringify(confirmResult)}`,
    )
    await manager.cancel(PROBE_NEGATIVE_ACCOUNT_ID)
    await waitUntil(() => manager.debugState().browsers.length === 0, {
      timeoutMs: 15000,
      label: '探测用例窗口关闭',
    })
  })

  // =========================================================================
  // 7. browser.js：visible 账号 / 清理 / 安全
  // =========================================================================

  await step('manager: account.visible === true 时 fetch 使用 headed 浏览器', async () => {
    let slowSettled = null
    const slowPromise = manager.fetch(visibleAccount, `${fixture.url}/slow?ms=1200`).then((result) => {
      slowSettled = result
      return result
    })
    try {
      await waitUntil(
        () => manager.debugState().browsers.some((browser) => browser.headed === true),
        { timeoutMs: 20000, label: '可见账号使用 headed 浏览器' },
      )
    } catch (error) {
      await slowPromise.catch(() => {})
      throw new Error(`${error.message}；fetch 结果：${JSON.stringify(slowSettled)}`)
    }
    const result = await slowPromise
    assert.equal(result.status, 'ok', `visible 账号 fetch 应成功：${JSON.stringify(result)}`)
    assert.match(result.text, /慢页面/)

    const headlessPromise = manager.fetch(account, `${fixture.url}/slow?ms=600`)
    await waitUntil(
      () => manager.debugState().browsers.some((browser) => browser.headed === false),
      { timeoutMs: 15000, label: '普通账号使用 headless 浏览器' },
    )
    const headlessResult = await headlessPromise
    assert.equal(headlessResult.status, 'ok', `headless fetch 应成功：${JSON.stringify(headlessResult)}`)
  })

  await step('manager: closeAll 关闭 pending 窗口与全部浏览器', async () => {
    await manager.fetch(account, `${fixture.url}/challenge`)
    assert.ok(manager.pending(), 'closeAll 前应有 pending')
    await manager.closeAll()
    assert.equal(manager.pending(), null, 'closeAll 后 pending 应为 null')
    assert.deepEqual(manager.debugState().active, [], 'closeAll 后不应有活跃窗口')
    assert.deepEqual(manager.debugState().browsers, [], 'closeAll 后不应有存活浏览器')
    await sleep(500)
  })

  await step('manager: removeProfile 删除账号 profile 目录（含登录 cookie）', async () => {
    const accountProfileDir = join(profilesDir, ACCOUNT_ID)
    assert.equal(existsSync(accountProfileDir), true, '删除前 profile 目录应存在')
    await manager.removeProfile(ACCOUNT_ID)
    assert.equal(existsSync(accountProfileDir), false, 'removeProfile 后 profile 目录应被删除')
    await manager.removeProfile('acc_not_exists_000') // 容忍不存在
    assert.equal(existsSync(join(profilesDir, 'acc_not_exists_000')), false)
  })

  await step('manager: 无浏览器环境返回 NO_BROWSER 错误', async () => {
    const brokenManager = createBrowserManager({
      store,
      profilesDir: join(workDir, 'profiles-broken'),
      config: { browserPath: 'C:\\no-such-browser\\msedge.exe' },
    })
    const availability = brokenManager.available()
    assert.equal(availability.browserAvailable, false)
    assert.ok(availability.error, '应带 error 说明')
    const loginResult = await brokenManager.login(ACCOUNT_ID)
    assert.equal(loginResult.status, 'error')
    assert.equal(loginResult.error.code, 'NO_BROWSER', `应返回 NO_BROWSER，实际 ${JSON.stringify(loginResult)}`)
    const fetchResult = await brokenManager.fetch(account, `${fixture.url}/`)
    assert.equal(fetchResult.status, 'error')
    assert.equal(fetchResult.error.code, 'NO_BROWSER')
    await brokenManager.closeAll()
  })

  await step('security: 日志 / pending / 会话写入均无明文密码', async () => {
    const allLogs = capturedLogs.join('\n')
    assert.ok(!allLogs.includes('fixture-pass'), 'manager 日志不得包含明文密码')
    assert.ok(!JSON.stringify(manager.pending()).includes('fixture-pass'), 'pending 不得包含密码')
    assert.ok(!JSON.stringify(manager.debugState()).includes('fixture-pass'), 'debugState 不得包含密码')
    for (const write of store.sessionWrites) {
      assert.ok(!('password' in write.patch), 'setSession patch 不应包含 password 字段')
      assert.ok(!JSON.stringify(write.patch).includes('fixture-pass'), 'setSession patch 不得包含明文密码')
    }
  })
} catch (error) {
  results.push({ name: 'unexpected top-level error', ok: false, error })
  console.error('UNEXPECTED ERROR:', error && error.stack ? error.stack : error)
} finally {
  // -------------------------------------------------------------------------
  // 清理 + 摘要
  // -------------------------------------------------------------------------
  if (manager) {
    try {
      managerPids.push(...manager.debugState().launchedPids)
    } catch {
      /* ignore */
    }
    try {
      await manager.closeAll()
    } catch {
      /* ignore */
    }
  }
  if (rawBrowser) {
    try {
      await rawBrowser.close()
    } catch {
      /* ignore */
    }
  }
  await sleep(800)
  for (const server of [fixture, fixtureAuto, fixtureOauth]) {
    if (!server) continue
    try {
      await server.close()
    } catch {
      /* ignore */
    }
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(workDir, { recursive: true, force: true, maxRetries: 3 })
      break
    } catch {
      await sleep(500)
    }
  }

  const watchedPids = [...new Set([...rawPids, ...managerPids])]
  const alive = watchedPids.filter(isProcessAlive)

  const passed = results.filter((item) => item.ok).length
  const failed = results.filter((item) => !item.ok)
  console.log('')
  console.log('==================== 浏览器驱动测试摘要 ====================')
  for (const item of results) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}`)
  }
  console.log(`通过 ${passed}/${results.length}，失败 ${failed.length}`)
  console.log(`启动过的浏览器进程：${watchedPids.length} 个，残留 ${alive.length} 个${alive.length ? `（pid: ${alive.join(', ')}）` : '（无残留）'}`)
  console.log('临时目录：已清理', workDir)
  console.log('============================================================')
  process.exit(failed.length === 0 && alive.length === 0 ? 0 : 1)
}
