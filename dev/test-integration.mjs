/**
 * Lead 集成测试：真实 store + 真实 browser manager + accountService + routes + tools。
 * 运行：<workspace-node> dev/test-integration.mjs
 * 依赖本地夹具 HTTP 服务，Edge 会短暂弹出（登录/人机验证场景），测试完自动关闭。
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { createStore } from '../lib/store.js'
import { createBrowserManager } from '../lib/browser.js'
import { createAccountService } from '../lib/accountService.js'
import { registerRoutes } from '../lib/routes.js'
import { registerTools } from '../lib/tools.js'

const LOG = (...a) => console.log('[it]', ...a)
const results = []
function record(name, ok, error) {
  results.push({ name, ok, error })
  if (ok) LOG(`PASS ${name}`)
  else LOG(`FAIL ${name}: ${error && (error.stack || error.message || error)}`)
}
async function step(name, fn) {
  try {
    await fn()
    record(name, true)
  } catch (error) {
    record(name, false, error)
  }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

/* ------------------------------------------------------------------ fixture */

const COOKIE = 'sid=ok'

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
        const params = new URLSearchParams(body)
        const user = params.get('username') || ''
        const pass = params.get('password') || ''
        if (user && pass) redirect('/account')
        else send(200, '<html><body><h1>登录失败</h1><form method="post" action="/login"><input name="username"><input type="password" name="password"><button type="submit">登录</button></form></body></html>')
      })
      return
    }
    if (url.pathname === '/login') {
      send(200, `<!doctype html><html><head><title>测试站点登录</title></head><body>
        <h1>请登录测试站点</h1>
        <form method="post" action="/login">
          <label>账号 <input type="text" name="username" autocomplete="username"></label>
          <label>密码 <input type="password" name="password" autocomplete="current-password"></label>
          <button type="submit">登录</button>
        </form>
      </body></html>`)
      return
    }
    if (url.pathname === '/account') {
      if (!hasCookie) return send(302, '', { location: '/login' })
      send(200, '<html><body><h1>我的账号</h1><p>退出登录</p><a href="/article">文章</a></body></html>')
      return
    }
    if (url.pathname === '/article') {
      if (!hasCookie) return send(302, '', { location: '/login' })
      send(200, '<html><head><title>付费文献</title></head><body><nav>导航</nav><article><h1>Nature 风格论文</h1><p>ARTICLE_MARKER 这是登录后才能阅读的文献正文，包含研究数据与结论。</p></article><footer>页脚</footer></body></html>')
      return
    }
    if (url.pathname === '/search') {
      if (!hasCookie) return send(302, '', { location: '/login' })
      const q = url.searchParams.get('q') || ''
      send(200, `<html><head><title>搜索 ${q}</title></head><body><h1>搜索结果：${q}</h1><ul><li><a href="/article">RESULTS_MARKER 相关文献一</a></li></ul></body></html>`)
      return
    }
    if (url.pathname === '/manual-login') {
      send(200, `<!doctype html><html><head><title>第三方登录</title></head><body>
        <h1>请用 Google 或通行密钥登录</h1>
        <p>此账号不支持密码登录（模拟 Google 注册账号）。</p>
        <button id="third-party">Continue with Google</button>
        <script>setTimeout(function(){document.cookie='${COOKIE}; Path=/; Max-Age=3600';location.href='/account'}, 3000)</script>
      </body></html>`)
      return
    }
    if (url.pathname === '/challenge') {
      send(200, `<!doctype html><html><head><title>安全验证</title></head><body>
        <h1>人机验证</h1><p>请完成真人验证后继续</p>
        <div class="g-recaptcha" data-sitekey="test"></div>
        <iframe src="about:blank" title="captcha"></iframe>
        <script>setTimeout(function(){document.cookie='${COOKIE}; Path=/; Max-Age=3600';location.href='/account'}, 5000)</script>
      </body></html>`)
      return
    }
    if (url.pathname === '/') return redirect('/account')
    send(404, 'not found')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ server, origin: `http://127.0.0.1:${port}` })
    })
  })
}

/* ----------------------------------------------------------- http test util */

function fakeWebServerCtx() {
  const routes = []
  const ctx = {
    webServer: {
      register(route) {
        routes.push(route)
        return () => {
          const i = routes.indexOf(route)
          if (i >= 0) routes.splice(i, 1)
        }
      },
    },
    effect(fn) {
      const dispose = fn()
      return () => { if (typeof dispose === 'function') dispose() }
    },
  }
  return { ctx, routes }
}

function findRoute(routes, method, path) {
  return routes.find((r) => r.path === path || (r.kind === 'prefix' && path.startsWith(r.path)))
}

async function callRoute(routes, method, path, body) {
  const route = findRoute(routes, method, path)
  assert.ok(route, `route not found: ${method} ${path}`)
  const buf = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))
  const req = Readable.from(buf.length > 0 ? [buf] : [])
  req.method = method
  req.url = path
  req.headers = { 'content-type': 'application/json', 'content-length': String(buf.length) }
  const res = await new Promise((resolve, reject) => {
    const out = { statusCode: 0, headers: {}, body: '' }
    out.writeHead = (code, headers) => { out.statusCode = code; out.headers = headers || {} }
    out.end = (chunk) => {
      if (chunk) out.body += chunk.toString()
      resolve(out)
    }
    Promise.resolve()
      .then(() => route.handler(req, out))
      .catch(reject)
  })
  let json
  try { json = JSON.parse(res.body) } catch { json = undefined }
  return { ...res, json }
}

function fakeToolsCtx() {
  const defs = []
  const ctx = {
    tools: {
      register(def) { defs.push(def); return () => {} },
    },
    effect(fn) { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose() } },
  }
  return { ctx, defs }
}

/* -------------------------------------------------------------------- main */

const tempDir = mkdtempSync(join(tmpdir(), 'account-hub-it-'))
let fixture
let store
let browser
let service

try {
  fixture = await startFixture()
  LOG('fixture at', fixture.origin)
  store = await createStore({ dir: join(tempDir, 'data') })
  browser = createBrowserManager({
    store,
    profilesDir: join(tempDir, 'profiles'),
    config: { loginTimeoutMs: 45000, pageTimeoutMs: 30000, autoOpenOnChallenge: true, pollIntervalMs: 1000 },
    log: LOG,
  })
  service = createAccountService({ store, browser, config: {}, log: LOG })

  let created
  let second

  await step('store: 空目录初始为空', async () => {
    assert.deepEqual(await store.list(), [])
  })

  await step('store: 创建账号并返回公开结构', async () => {
    created = await store.create({
      label: '夹具站点',
      url: fixture.origin,
      loginUrl: `${fixture.origin}/login`,
      searchUrl: `${fixture.origin}/search?q={query}`,
      username: 'reader@example.com',
      password: 'S3cret-Passw0rd!',
      notes: 'integration',
    })
    assert.ok(created.id, 'id')
    assert.equal(created.username, 'reader@example.com')
    assert.equal(created.password, undefined)
    assert.equal(created.session.status, 'unknown')
  })

  await step('store: 列表不含密码字段', async () => {
    const list = await store.list()
    assert.equal(list.length, 1)
    assert.equal(JSON.stringify(list).includes('S3cret-Passw0rd!'), false)
  })

  await step('store: 落盘加密（明文密码不出现在文件）', async () => {
    const raw = readFileSync(join(tempDir, 'data', 'accounts.json'), 'utf8')
    assert.equal(raw.includes('S3cret-Passw0rd!'), false)
    assert.match(raw, /aes-256-gcm/)
  })

  await step('store: get 返回可解密密码', async () => {
    const rec = await store.get(created.id)
    assert.equal(rec.password, 'S3cret-Passw0rd!')
  })

  await step('store: update 空密码保持不变', async () => {
    const updated = await store.update(created.id, { label: '夹具站点-改', password: '' })
    assert.equal(updated.label, '夹具站点-改')
    const rec = await store.get(created.id)
    assert.equal(rec.password, 'S3cret-Passw0rd!')
  })

  await step('store: 创建第二个账号并删除', async () => {
    second = await store.create({ label: '临时', url: 'https://example.com', username: 'u2', password: 'p2' })
    await store.remove(second.id)
    const list = await store.list()
    assert.equal(list.length, 1)
  })

  await step('store: 非法 URL 被拒绝', async () => {
    await assert.rejects(() => store.create({ url: 'ftp://x', username: 'u', password: 'p' }), (e) => e.code === 'INVALID_INPUT')
  })

  await step('service: state 结构', async () => {
    const state = await service.state()
    assert.equal(state.accounts.length, 1)
    assert.ok('pending' in state)
    assert.ok(state.browser)
    assert.equal(typeof state.browser.available, 'boolean')
  })

  const { ctx: webCtx, routes } = fakeWebServerCtx()
  await step('routes: 注册至少 10 条路由', async () => {
    const dispose = registerRoutes(webCtx, service, LOG)
    assert.ok(routes.length >= 10, `routes=${routes.length}`)
    assert.equal(typeof dispose, 'function')
  })

  await step('routes: GET /state envelope', async () => {
    const res = await callRoute(routes, 'GET', '/api/account-hub/state')
    assert.equal(res.statusCode, 200)
    assert.equal(res.json.ok, true)
    assert.equal(Array.isArray(res.json.data.accounts), true)
  })

  await step('routes: POST /accounts 创建 + 列表 + 删除', async () => {
    const createdRes = await callRoute(routes, 'POST', '/api/account-hub/accounts', {
      label: '路由账号',
      url: fixture.origin,
      username: 'route@example.com',
      password: 'route-pass',
    })
    assert.equal(createdRes.json.ok, true, JSON.stringify(createdRes.json))
    const id = createdRes.json.data.id
    const listRes = await callRoute(routes, 'GET', '/api/account-hub/accounts')
    assert.ok(listRes.json.data.some((a) => a.id === id))
    const updRes = await callRoute(routes, 'POST', '/api/account-hub/accounts/update', { id, username: 'route2@example.com' })
    assert.equal(updRes.json.ok, true)
    assert.equal(updRes.json.data.username, 'route2@example.com')
    const delRes = await callRoute(routes, 'POST', '/api/account-hub/accounts/delete', { id })
    assert.equal(delRes.json.ok, true)
    const list2 = await callRoute(routes, 'GET', '/api/account-hub/accounts')
    assert.equal(list2.json.data.some((a) => a.id === id), false)
  })

  await step('routes: 非法请求返回错误 envelope', async () => {
    const res = await callRoute(routes, 'POST', '/api/account-hub/accounts', { label: '坏', url: 'not-a-url', username: '', password: '' })
    assert.equal(res.json.ok, false)
    assert.ok(res.json.error && res.json.error.message)
  })

  const { ctx: toolCtx, defs } = fakeToolsCtx()
  await step('tools: 注册四个 account_hub_* 工具', async () => {
    registerTools(toolCtx, service, LOG)
    const names = defs.map((d) => d.name).sort()
    assert.deepEqual(names, ['account_hub_fetch', 'account_hub_list', 'account_hub_login', 'account_hub_search'])
    for (const d of defs) {
      assert.equal(typeof d.description, 'string')
      assert.ok(d.parameters && d.parameters.type === 'object')
      assert.ok(d.output && d.output.schema && typeof d.output.render === 'function')
      assert.equal(typeof d.execute, 'function')
    }
  })

  await step('tools: account_hub_list 返回账号摘要', async () => {
    const def = defs.find((d) => d.name === 'account_hub_list')
    const value = await def.execute({}, { signal: new AbortController().signal })
    assert.equal(value.accounts.length, 1)
    assert.equal(value.accounts[0].label, '夹具站点-改')
    assert.ok('pending' in value)
  })

  await step('browser: 启动器可用', async () => {
    const avail = browser.available()
    assert.equal(avail.browserAvailable, true, JSON.stringify(avail))
  })

  const account = () => store.get(created.id)

  await step('browser: 自动填表登录并保存会话', async () => {
    const res = await browser.login(created.id)
    assert.ok(['started', 'pending', 'busy'].includes(res.status), JSON.stringify(res))
    const deadline = Date.now() + 40000
    while (Date.now() < deadline) {
      const rec = await account()
      if (rec.session.status === 'authenticated') return
      await sleep(1000)
    }
    const rec = await account()
    throw new Error('login did not reach authenticated, status=' + rec.session.status)
  })

  await step('browser: 带会话 fetch 受保护文章', async () => {
    const res = await browser.fetch(await account(), `${fixture.origin}/article`)
    assert.equal(res.status, 'ok', JSON.stringify(res))
    assert.match(res.text, /ARTICLE_MARKER/)
  })

  await step('browser: search 使用会话 + 搜索模板', async () => {
    const res = await browser.search(await account(), '文献测试')
    assert.equal(res.status, 'ok', JSON.stringify(res))
    assert.match(res.text, /RESULTS_MARKER/)
  })

  await step('browser: 遇验证码返回 verification-required 并开可见窗口', async () => {
    const res = await browser.fetch(await account(), `${fixture.origin}/challenge`)
    assert.equal(res.status, 'verification-required', JSON.stringify(res))
    assert.ok(res.pending && res.pending.accountId === created.id)
    assert.equal(res.challenge.kind, 'captcha', JSON.stringify(res.challenge))
  })

  await step('browser: 用户完成验证后自动继续（夹具 5s 自动通过）', async () => {
    const deadline = Date.now() + 40000
    while (Date.now() < deadline) {
      if (browser.pending() === null) {
        const res = await browser.fetch(await account(), `${fixture.origin}/article`)
        assert.equal(res.status, 'ok', JSON.stringify(res))
        assert.match(res.text, /ARTICLE_MARKER/)
        return
      }
      await sleep(1000)
    }
    throw new Error('verification pending never cleared')
  })

  await step('browser: manual 模式（Google/passkey 账号）只开窗口不填表，用户完成后自动成功', async () => {
    const manual = await store.create({
      label: '手动登录站点',
      url: fixture.origin,
      loginUrl: `${fixture.origin}/manual-login`,
      username: 'oauth@example.com',
      password: 'unused-pass',
      loginMode: 'manual',
    })
    assert.equal(manual.loginMode, 'manual')
    const started = await browser.login(manual.id)
    assert.ok(['started', 'pending', 'busy'].includes(started.status), JSON.stringify(started))
    const deadline = Date.now() + 40000
    while (Date.now() < deadline) {
      const rec = await store.get(manual.id)
      if (rec.session.status === 'authenticated') {
        const res = await browser.fetch(rec, `${fixture.origin}/article`)
        assert.equal(res.status, 'ok', JSON.stringify(res))
        assert.match(res.text, /ARTICLE_MARKER/)
        await store.remove(manual.id)
        return
      }
      await sleep(1000)
    }
    const rec = await store.get(manual.id)
    throw new Error('manual login did not reach authenticated: ' + rec.session.status)
  })

  await step('browser: fetch 无会话且挑战时的错误路径', async () => {
    const spare = await store.create({ label: '无会话', url: fixture.origin, username: 'u3', password: 'p3' })
    const res = await browser.fetch(await store.get(spare.id), `${fixture.origin}/article`)
    assert.ok(['login-required', 'verification-required', 'error', 'ok'].includes(res.status), JSON.stringify(res))
    await browser.cancel(spare.id).catch(() => {})
    await store.remove(spare.id)
  })

  await step('service: test() 会话测试', async () => {
    const res = await service.test(created.id)
    assert.ok(['ok', 'login-required', 'verification-required', 'error'].includes(res.status), JSON.stringify(res))
  })

  await step('tools: account_hub_fetch 读取受保护文章', async () => {
    const def = defs.find((d) => d.name === 'account_hub_fetch')
    const value = await def.execute({ account: created.id, url: `${fixture.origin}/article` }, { signal: new AbortController().signal })
    assert.equal(value.status, 'ok', JSON.stringify(value))
    assert.match(value.text, /ARTICLE_MARKER/)
  })
} catch (error) {
  record('unexpected top-level error', false, error)
} finally {
  try { if (browser) await browser.closeAll() } catch (e) { LOG('closeAll failed:', e && e.message) }
  try { if (fixture && fixture.server) await new Promise((r) => fixture.server.close(r)) } catch {}
  await sleep(1200)
  try { rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }) } catch (e) { LOG('cleanup temp dir failed:', e && e.message) }
}

const failed = results.filter((r) => !r.ok)
LOG(`\n==== ${results.length - failed.length}/${results.length} PASSED ====`)
if (failed.length > 0) {
  for (const f of failed) LOG(`FAILED: ${f.name}`)
  process.exitCode = 1
} else {
  LOG('ALL INTEGRATION TESTS PASSED')
}
