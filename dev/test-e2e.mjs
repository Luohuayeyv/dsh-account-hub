/**
 * Lead 端到端测试：对已安装的 dsh-account-hub 插件，通过本机 HTTP 路由验证
 * 账号 CRUD、交互登录、带会话抓取/搜索、真人验证挂起与恢复、删除清理。
 * 运行：<workspace-node> dev/test-e2e.mjs
 * 前置：插件已安装并激活（webServer 路由可访问）。
 */
import http from 'node:http'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const BASE = process.env.DSH_WEB_URL || 'http://127.0.0.1:50461'
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const PROFILE_DIR = join(DSH_HOME, 'account-hub', 'profiles')
const COOKIE = 'sid=ok'
const LOG = (...a) => console.log('[e2e]', ...a)
const results = []
function record(name, ok, error) {
  results.push({ name, ok, error })
  if (ok) LOG(`PASS ${name}`)
  else LOG(`FAIL ${name}: ${error && (error.stack || error.message || error)}`)
}
async function step(name, fn) {
  try { await fn(); record(name, true) } catch (e) { record(name, false, e) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-cache' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = undefined }
  return { status: res.status, json, text }
}
async function state() {
  const res = await api('GET', '/api/account-hub/state')
  if (!res.json || res.json.ok !== true) throw new Error(`state failed status=${res.status} body=${res.text.slice(0, 300)}`)
  return res.json.data
}

/* fixture（与集成测试一致） */
function startFixture() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const hasCookie = String(req.headers.cookie || '').includes(COOKIE)
    const send = (code, html, headers = {}) => {
      res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', ...headers })
      res.end(html)
    }
    const redirect = (to) => {
      res.writeHead(302, { location: to, 'set-cookie': `${COOKIE}; Path=/; Max-Age=3600` })
      res.end()
    }
    if (req.method === 'POST' && url.pathname === '/login') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        const p = new URLSearchParams(body)
        if ((p.get('username') || '') && (p.get('password') || '')) redirect('/account')
        else send(200, '<html><body><h1>登录失败</h1><form method="post" action="/login"><input name="username"><input type="password" name="password"><button type="submit">登录</button></form></body></html>')
      })
      return
    }
    if (url.pathname === '/login') {
      send(200, `<!doctype html><html><head><title>E2E 登录页</title></head><body><h1>请登录</h1>
        <form method="post" action="/login">
          <label>账号 <input type="text" name="username" autocomplete="username"></label>
          <label>密码 <input type="password" name="password" autocomplete="current-password"></label>
          <button type="submit">登录</button>
        </form></body></html>`)
      return
    }
    if (url.pathname === '/manual-login') {
      send(200, `<!doctype html><html><head><title>第三方登录</title></head><body>
        <h1>请用 Google 或通行密钥登录（E2E 模拟）</h1>
        <button id="third-party">Continue with Google</button>
        <script>setTimeout(function(){document.cookie='${COOKIE}; Path=/; Max-Age=3600';location.href='/account'}, 3000)</script>
      </body></html>`)
      return
    }
    if (url.pathname === '/challenge') {
      send(200, `<!doctype html><html><head><title>安全验证</title></head><body><h1>人机验证</h1><p>请完成真人验证后继续</p>
        <div class="g-recaptcha" data-sitekey="test"></div>
        <script>setTimeout(function(){document.cookie='${COOKIE}; Path=/; Max-Age=3600';location.href='/account'}, 5000)</script>
      </body></html>`)
      return
    }
    if (url.pathname === '/article') {
      if (!hasCookie) return send(302, '', { location: '/login' })
      send(200, '<html><head><title>E2E 文献</title></head><body><nav>导航</nav><article><h1>受保护文献</h1><p>ARTICLE_MARKER E2E 登录后才能阅读的正文内容。</p></article></body></html>')
      return
    }
    if (url.pathname === '/search') {
      if (!hasCookie) return send(302, '', { location: '/login' })
      const q = url.searchParams.get('q') || ''
      send(200, `<html><head><title>搜索 ${q}</title></head><body><h1>搜索结果：${q}</h1><p>RESULTS_MARKER 相关文献</p></body></html>`)
      return
    }
    if (url.pathname === '/') return redirect('/account')
    send(404, 'not found')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }))
  })
}

let fixture
let accountId = null
let manualId = null
let createdLabel = null

try {
  fixture = await startFixture()
  LOG('fixture at', fixture.origin, 'plugin at', BASE)

  await step('路由可达：GET /api/account-hub/state', async () => {
    const st = await state()
    if (!Array.isArray(st.accounts)) throw new Error('accounts not array: ' + JSON.stringify(st).slice(0, 200))
    if (!st.browser || typeof st.browser.available !== 'boolean') throw new Error('browser info missing')
  })

  createdLabel = `E2E 测试账号 ${Date.now()}`
  await step('创建账号（API）', async () => {
    const res = await api('POST', '/api/account-hub/accounts', {
      label: createdLabel,
      url: fixture.origin,
      loginUrl: `${fixture.origin}/login`,
      searchUrl: `${fixture.origin}/search?q={query}`,
      username: 'e2e@example.com',
      password: 'E2E-Passw0rd!',
      notes: 'e2e',
    })
    if (!res.json || res.json.ok !== true) throw new Error('create failed: ' + res.text.slice(0, 300))
    accountId = res.json.data.id
    if (res.text.includes('E2E-Passw0rd!')) throw new Error('password leaked in response')
  })

  await step('账号出现在 list，且不含密码', async () => {
    const res = await api('GET', '/api/account-hub/accounts')
    const found = res.json.data.find((a) => a.id === accountId)
    if (!found) throw new Error('account missing')
    if ('password' in found) throw new Error('password field leaked')
    if (found.label !== createdLabel) throw new Error('label mismatch')
  })

  await step('启动交互登录（打开可见 Edge 并自动填表）', async () => {
    const res = await api('POST', '/api/account-hub/login', { id: accountId })
    if (!res.json || res.json.ok !== true) throw new Error('login failed: ' + res.text.slice(0, 300))
    const status = res.json.data.status
    if (!['started', 'pending', 'busy'].includes(status)) throw new Error('unexpected login status ' + status)
  })

  await step('登录完成：会话变为 authenticated', async () => {
    const deadline = Date.now() + 60000
    while (Date.now() < deadline) {
      const st = await state()
      const acc = st.accounts.find((a) => a.id === accountId)
      if (acc && acc.session && acc.session.status === 'authenticated') return
      await sleep(1500)
    }
    const st = await state()
    const acc = st.accounts.find((a) => a.id === accountId)
    throw new Error('login not authenticated: ' + JSON.stringify(acc && acc.session))
  })

  await step('带会话抓取受保护文章（fetch）', async () => {
    const res = await api('POST', '/api/account-hub/fetch', { id: accountId, url: `${fixture.origin}/article` })
    const data = res.json && res.json.ok ? res.json.data : null
    if (!data) throw new Error('fetch failed: ' + res.text.slice(0, 300))
    if (data.status !== 'ok') throw new Error('fetch status=' + data.status)
    if (!String(data.text || '').includes('ARTICLE_MARKER')) throw new Error('article text missing')
  })

  await step('带会话站内搜索（search + 模板）', async () => {
    const res = await api('POST', '/api/account-hub/search', { id: accountId, query: '文献检索' })
    const data = res.json && res.json.ok ? res.json.data : null
    if (!data) throw new Error('search failed: ' + res.text.slice(0, 300))
    if (data.status !== 'ok') throw new Error('search status=' + data.status)
    if (!String(data.text || '').includes('RESULTS_MARKER')) throw new Error('search text missing')
  })

  await step('测试会话（test）', async () => {
    const res = await api('POST', '/api/account-hub/test', { id: accountId })
    const data = res.json && res.json.ok ? res.json.data : null
    if (!data) throw new Error('test failed: ' + res.text.slice(0, 300))
    if (!['ok', 'login-required', 'verification-required', 'error'].includes(data.status)) throw new Error('unexpected test status ' + data.status)
  })

  await step('真人验证交接：fetch 返回 verification-required + pending', async () => {
    const res = await api('POST', '/api/account-hub/fetch', { id: accountId, url: `${fixture.origin}/challenge` })
    const data = res.json && res.json.ok ? res.json.data : null
    if (!data) throw new Error('challenge fetch failed: ' + res.text.slice(0, 300))
    if (data.status !== 'verification-required') throw new Error('expected verification-required, got ' + data.status)
    const st = await state()
    if (!st.pending || st.pending.accountId !== accountId) throw new Error('pending missing: ' + JSON.stringify(st.pending))
  })

  await step('用户完成验证后 confirm 并恢复会话', async () => {
    await sleep(2500)
    const confirm = await api('POST', '/api/account-hub/login/confirm', { id: accountId })
    if (!confirm.json || confirm.json.ok !== true) throw new Error('confirm failed: ' + confirm.text.slice(0, 300))
    const deadline = Date.now() + 40000
    while (Date.now() < deadline) {
      const st = await state()
      const acc = st.accounts.find((a) => a.id === accountId)
      if (st.pending === null && acc && acc.session && acc.session.status === 'authenticated') return
      await sleep(1000)
    }
    const st = await state()
    throw new Error('not recovered after confirm: pending=' + JSON.stringify(st.pending) + ' acc=' + JSON.stringify(st.accounts.find((a) => a.id === accountId)))
  })

  await step('验证完成后再次抓取文章成功', async () => {
    const res = await api('POST', '/api/account-hub/fetch', { id: accountId, url: `${fixture.origin}/article` })
    const data = res.json && res.json.ok ? res.json.data : null
    if (!data || data.status !== 'ok') throw new Error('post-verify fetch failed: ' + res.text.slice(0, 300))
    if (!String(data.text || '').includes('ARTICLE_MARKER')) throw new Error('article missing after verify')
  })

  await step('manual 登录模式：只开窗口不填表，用户完成后会话自动保存', async () => {
    const createRes = await api('POST', '/api/account-hub/accounts', {
      label: `E2E 手动登录 ${Date.now()}`,
      url: fixture.origin,
      loginUrl: `${fixture.origin}/manual-login`,
      username: 'oauth@example.com',
      password: 'unused-pass',
      loginMode: 'manual',
    })
    if (!createRes.json || createRes.json.ok !== true) throw new Error('create manual failed: ' + createRes.text.slice(0, 300))
    manualId = createRes.json.data.id
    if (createRes.json.data.loginMode !== 'manual') throw new Error('loginMode not persisted')
    const loginRes = await api('POST', '/api/account-hub/login', { id: manualId })
    if (!loginRes.json || loginRes.json.ok !== true) throw new Error('manual login start failed: ' + loginRes.text.slice(0, 300))
    const deadline = Date.now() + 60000
    while (Date.now() < deadline) {
      const st = await state()
      const acc = st.accounts.find((a) => a.id === manualId)
      if (acc && acc.session && acc.session.status === 'authenticated') {
        const fetchRes = await api('POST', '/api/account-hub/fetch', { id: manualId, url: `${fixture.origin}/article` })
        const data = fetchRes.json && fetchRes.json.ok ? fetchRes.json.data : null
        if (!data || data.status !== 'ok') throw new Error('manual-mode fetch failed: ' + fetchRes.text.slice(0, 300))
        if (!String(data.text || '').includes('ARTICLE_MARKER')) throw new Error('manual-mode article text missing')
        const delRes = await api('POST', '/api/account-hub/accounts/delete', { id: manualId })
        if (!delRes.json || delRes.json.ok !== true) throw new Error('delete manual failed')
        manualId = null
        return
      }
      await sleep(1500)
    }
    throw new Error('manual login did not reach authenticated')
  })

  await step('删除账号：列表移除 + profile 目录清理', async () => {
    const res = await api('POST', '/api/account-hub/accounts/delete', { id: accountId })
    if (!res.json || res.json.ok !== true) throw new Error('delete failed: ' + res.text.slice(0, 300))
    const list = await api('GET', '/api/account-hub/accounts')
    if (list.json.data.some((a) => a.id === accountId)) throw new Error('account still listed')
    const st = await state()
    if (st.pending && st.pending.accountId === accountId) throw new Error('pending not cleared after delete')
    await sleep(1200)
    const profilePath = join(PROFILE_DIR, accountId)
    if (existsSync(profilePath)) throw new Error('profile dir not cleaned: ' + profilePath)
    accountId = null
  })
} catch (error) {
  record('unexpected top-level error', false, error)
} finally {
  if (accountId) {
    try { await api('POST', '/api/account-hub/login/cancel', { id: accountId }) } catch {}
    try { await api('POST', '/api/account-hub/accounts/delete', { id: accountId }) } catch {}
  }
  if (manualId) {
    try { await api('POST', '/api/account-hub/login/cancel', { id: manualId }) } catch {}
    try { await api('POST', '/api/account-hub/accounts/delete', { id: manualId }) } catch {}
  }
  try { if (fixture) await new Promise((r) => fixture.server.close(r)) } catch {}
}

const failed = results.filter((r) => !r.ok)
LOG(`\n==== ${results.length - failed.length}/${results.length} PASSED ====`)
if (failed.length > 0) {
  for (const f of failed) LOG(`FAILED: ${f.name}`)
  process.exitCode = 1
} else {
  LOG('ALL E2E TESTS PASSED')
}
