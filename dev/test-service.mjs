#!/usr/bin/env node
/**
 * dsh-account-hub — Host service test (no DSH runtime required).
 *
 * Covers, with a real encrypted store and a fake browser manager:
 *   - store CRUD, password encryption at rest, atomic/serialized writes, corruption tolerance
 *   - accountService operations, error codes, session merges, profile cleanup on delete
 *   - the four agent tools: registration shape, execute results, error envelopes, isConcurrencySafe
 *   - the 11 HTTP routes: JSON envelopes, status codes, 64 KiB body cap, disposers
 *   - (optional) index.js assembly when lib/browser.js has been delivered
 *
 * Run with the workspace Node:
 *   C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe dev/test-service.mjs
 *
 * Exits 0 when every check passes, 1 otherwise.
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createStore } from '../lib/store.js'
import { createAccountService } from '../lib/accountService.js'
import { registerRoutes, ENDPOINT_COUNT } from '../lib/routes.js'
import { registerTools } from '../lib/tools.js'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PASSWORD = 'Sup3rSecret!pw-账号-42'
const NEW_PASSWORD = 'Rotated#Passw0rd-9137'
// Any response body / tool result must never contain these sentinels.
const SECRET_SENTINELS = [PASSWORD, NEW_PASSWORD]

const tempDirs = []
let passed = 0
const failures = []

function section(title) {
  console.log(`\n=== ${title} ===`)
}

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`PASS  ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.error(`FAIL  ${name}`)
    console.error(String(error?.stack || error).split('\n').map((line) => `      ${line}`).join('\n'))
  }
}

async function makeTempDir(label) {
  const dir = await mkdtemp(path.join(tmpdir(), `account-hub-${label}-`))
  tempDirs.push(dir)
  return dir
}

async function expectRejection(fn, expectedCode) {
  let caught
  try {
    await fn()
  } catch (error) {
    caught = error
  }
  assert.ok(caught, `expected a rejection with code ${expectedCode}, but the call resolved`)
  assert.equal(caught.code, expectedCode, `expected code ${expectedCode}, got ${caught.code || '<none>'}: ${caught.message}`)
  return caught
}

function assertNoSecrets(haystack, label) {
  const text = typeof haystack === 'string' ? haystack : JSON.stringify(haystack)
  for (const secret of SECRET_SENTINELS) {
    assert.ok(!text.includes(secret), `${label} leaked a plaintext password`)
  }
}

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 25, label = 'condition' } = {}) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`timed out waiting for ${label}`)
}

// ---- fake browser manager (contract §7 shapes, no real browser) ---------

function createFakeBrowserManager({ store }) {
  let pending = null
  const busy = new Set()
  const removedProfiles = []
  let closeAllCalls = 0

  const manager = {
    available() {
      return {
        browserAvailable: true,
        executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      }
    },
    pending() {
      return pending ? { ...pending } : null
    },
    isBusy(accountId) {
      return busy.has(accountId) || pending?.accountId === accountId
    },
    async login(accountId) {
      const record = await store.get(accountId)
      if (!record) return { status: 'error', error: { code: 'NOT_FOUND', message: '账号不存在' } }
      if (busy.has(accountId)) return { status: 'busy', hint: '该账号正在验证中' }
      busy.add(accountId)
      pending = {
        accountId,
        label: record.label,
        url: record.loginUrl || record.url,
        phase: 'verification-required',
        startedAt: new Date().toISOString(),
        hint: '请在浏览器窗口中完成真人验证',
      }
      await store.setSession(accountId, {
        status: 'verification-required',
        lastCheckedAt: new Date().toISOString(),
        detail: '等待用户完成真人验证',
      })
      return { status: 'started', hint: '已打开可见浏览器窗口，请完成验证' }
    },
    async confirm(accountId) {
      const record = await store.get(accountId)
      if (!record) return { status: 'error', error: { code: 'NOT_FOUND', message: '账号不存在' } }
      pending = null
      busy.delete(accountId)
      await store.setSession(accountId, {
        status: 'authenticated',
        lastLoginAt: new Date().toISOString(),
        lastCheckedAt: new Date().toISOString(),
        detail: '用户手动确认完成',
      })
      return { status: 'authenticated', detail: '用户手动确认完成' }
    },
    async cancel(accountId) {
      pending = null
      busy.delete(accountId)
      return { status: 'cancelled' }
    },
    async removeProfile(accountId) {
      removedProfiles.push(accountId)
    },
    async fetch(record, url) {
      if (String(url).includes('boom')) throw new Error('fake browser exploded')
      if (String(url).includes('challenge')) {
        const challengePending = {
          accountId: record.id,
          label: record.label,
          url,
          phase: 'verification-required',
          startedAt: new Date().toISOString(),
          hint: '请在可见浏览器窗口完成人机验证',
        }
        pending = challengePending
        busy.add(record.id)
        await store.setSession(record.id, { status: 'verification-required', lastCheckedAt: new Date().toISOString() })
        return {
          status: 'verification-required',
          url,
          title: 'Just a moment...',
          challenge: { kind: 'captcha', evidence: '.g-recaptcha + 人机验证' },
          pending: challengePending,
          hint: '请让用户在浏览器窗口中完成验证',
        }
      }
      return {
        status: 'ok',
        url,
        title: `Fake page for ${record.label}`,
        text: `Authenticated content for ${record.label}. `.repeat(20),
        links: [{ text: 'Next', url: 'https://example.test/next' }],
        challenge: null,
      }
    },
    async search(record, query) {
      const usedUrl = record.searchUrl
        ? record.searchUrl.replaceAll('{query}', encodeURIComponent(query))
        : `${new URL(record.url).origin}/search?q=${encodeURIComponent(query)}`
      return {
        status: 'ok',
        url: usedUrl,
        usedUrl,
        guessed: !record.searchUrl,
        title: `Search results for ${query}`,
        text: `Top results for ${query} via saved session.`,
        links: [{ text: 'First result', url: 'https://example.test/result-1' }],
        challenge: null,
      }
    },
    async closeAll() {
      closeAllCalls += 1
      pending = null
      busy.clear()
    },
    _inspect() {
      return { pending, busy: [...busy], removedProfiles, closeAllCalls }
    },
  }
  return manager
}

// ---- fake cordis plugin context ----------------------------------------

function createFakeCtx({ withWebServer = true, withTools = true, withSystemPrompt = false, failRegister = false } = {}) {
  const routes = new Map()
  const tools = new Map()
  const disposers = []
  const prompt = {
    sections: [],
    section(sectionDefinition) {
      this.sections.push(sectionDefinition)
      return () => {
        this.sections = this.sections.filter((item) => item !== sectionDefinition)
      }
    },
  }
  const routeRegistrar = {
    register(route) {
      if (failRegister) throw new Error('route registration exploded')
      const key = `${route.kind}:${route.path}`
      if (routes.has(key)) throw new Error(`duplicate route ${key}`)
      routes.set(key, route.handler)
      return () => routes.delete(key)
    },
  }
  const toolRegistrar = {
    register(definition) {
      if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
  }
  const ctx = {
    get(name) {
      if (name === 'webServer') return withWebServer ? routeRegistrar : undefined
      if (name === 'tools') return withTools ? toolRegistrar : undefined
      if (name === 'systemPrompt') return withSystemPrompt ? prompt : undefined
      return undefined
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    _routes: routes,
    _tools: tools,
    _disposers: disposers,
    _prompt: prompt,
    _disposeAll() {
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          dispose()
        } catch {
          /* ignore */
        }
      }
    },
  }
  return ctx
}

// ---- fake Node HTTP request/response -----------------------------------

function createMockRequest(method, url, body) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = {}
  req.resume = () => {}
  req.pause = () => {}
  req.destroy = () => {}
  process.nextTick(() => {
    if (body !== undefined) {
      const text = typeof body === 'string' ? body : JSON.stringify(body)
      req.emit('data', Buffer.from(text, 'utf8'))
    }
    req.emit('end')
  })
  return req
}

function createMockResponse() {
  const res = {
    statusCode: 0,
    headers: null,
    body: '',
    headersSent: false,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode
      this.headers = { ...headers }
      this.headersSent = true
      return this
    },
    end(chunk) {
      if (chunk !== undefined) this.body += String(chunk)
    },
    get json() {
      return this.body ? JSON.parse(this.body) : undefined
    },
  }
  return res
}

async function callRoute(ctx, method, routePath, body) {
  const handler = ctx._routes.get(`exact:${routePath}`)
  assert.ok(handler, `route was not registered: ${routePath}`)
  const req = createMockRequest(method, routePath, body)
  const res = createMockResponse()
  await handler(req, res)
  assert.ok(res.headersSent, `${method} ${routePath} did not send a response`)
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8', `${method} ${routePath} content-type`)
  assert.equal(res.headers['cache-control'], 'no-cache', `${method} ${routePath} cache-control`)
  assertNoSecrets(res.body, `${method} ${routePath} response`)
  return res
}

function assertOk(res, label) {
  const json = res.json
  assert.ok(json && typeof json === 'object', `${label}: response is not JSON`)
  assert.equal(json.ok, true, `${label}: expected ok:true, got ${JSON.stringify(json).slice(0, 300)}`)
  assert.ok('data' in json, `${label}: missing data`)
  return json.data
}

function assertFail(res, expectedCode, expectedStatus, label) {
  const json = res.json
  assert.ok(json && typeof json === 'object', `${label}: response is not JSON`)
  assert.equal(json.ok, false, `${label}: expected ok:false, got ${JSON.stringify(json).slice(0, 300)}`)
  assert.ok(json.error && typeof json.error === 'object', `${label}: missing error object`)
  assert.equal(json.error.code, expectedCode, `${label}: expected code ${expectedCode}, got ${json.error.code}`)
  assert.ok(typeof json.error.message === 'string' && json.error.message.length > 0, `${label}: missing error message`)
  if (expectedStatus !== undefined) assert.equal(res.statusCode, expectedStatus, `${label}: unexpected HTTP status`)
  return json.error
}

// ------------------------------------------------------------------------

async function runStoreTests() {
  section('store: encrypted CRUD')
  const dataDir = await makeTempDir('store')
  const store = await createStore({ dir: dataDir })

  await test('store.dir / list() is empty for a fresh directory', async () => {
    assert.equal(store.dir, path.resolve(dataDir))
    assert.deepEqual(await store.list(), [])
  })

  let nature
  await test('create() fills defaults: id, label=hostname, loginMode=auto, session, timestamps; no password field', async () => {
    nature = await store.create({
      url: 'https://www.nature.com',
      username: 'alice@example.test',
      password: PASSWORD,
      searchUrl: 'https://www.nature.com/search?q={query}',
      notes: 'journal reading',
    })
    assert.match(nature.id, /^acc_[0-9a-f]{12}$/)
    assert.equal(nature.label, 'www.nature.com')
    assert.equal(nature.url, 'https://www.nature.com')
    assert.equal(nature.loginUrl, '')
    assert.equal(nature.searchUrl, 'https://www.nature.com/search?q={query}')
    assert.equal(nature.username, 'alice@example.test')
    assert.equal(nature.loginMode, 'auto', 'loginMode must default to auto')
    assert.equal(nature.notes, 'journal reading')
    assert.equal(nature.visible, false)
    assert.deepEqual(nature.session, { status: 'unknown' })
    assert.match(nature.createdAt, /^\d{4}-\d{2}-\d{2}T/)
    assert.equal(nature.createdAt, nature.updatedAt)
    assert.ok(!('password' in nature), 'AccountPublic must not contain password')
  })

  await test('create() honours explicit label/loginUrl/visible/loginMode and `acc_` ids are unique', async () => {
    const account = await store.create({
      label: 'Science',
      url: 'https://www.science.org',
      loginUrl: 'https://www.science.org/login',
      username: 'alice',
      password: PASSWORD,
      visible: true,
      loginMode: 'manual',
    })
    assert.equal(account.label, 'Science')
    assert.equal(account.loginUrl, 'https://www.science.org/login')
    assert.equal(account.visible, true)
    assert.equal(account.loginMode, 'manual')
    assert.notEqual(account.id, nature.id)
  })

  await test('get() returns AccountRecord with the decrypted password and loginMode', async () => {
    const record = await store.get(nature.id)
    assert.equal(record.password, PASSWORD)
    assert.equal(record.username, 'alice@example.test')
    assert.equal(record.loginMode, 'auto')
    assert.equal(await store.get('acc_doesnotexist'), undefined)
  })

  await test('list() is sorted by createdAt and never exposes passwords', async () => {
    const accounts = await store.list()
    assert.ok(accounts.length >= 2)
    const sorted = [...accounts].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
    assert.deepEqual(accounts.map((item) => item.id), sorted.map((item) => item.id))
    assertNoSecrets(accounts, 'store.list()')
  })

  await test('accounts.json stores AES-256-GCM blobs only; the key file is 32 bytes', async () => {
    const dataFile = path.join(dataDir, 'accounts.json')
    const manifestText = await readFile(dataFile, 'utf8')
    assertNoSecrets(manifestText, 'accounts.json')
    const manifest = JSON.parse(manifestText)
    assert.equal(manifest.version, 1)
    assert.ok(Array.isArray(manifest.accounts))
    const storedNature = manifest.accounts.find((item) => item.id === nature.id)
    assert.equal(storedNature.password.algo, 'aes-256-gcm')
    assert.equal(storedNature.loginMode, 'auto', 'loginMode is persisted')
    for (const field of ['iv', 'tag', 'data']) {
      assert.equal(typeof storedNature.password[field], 'string')
      assert.match(storedNature.password[field], /^[A-Za-z0-9+/]+=*$/, `password.${field} is not base64`)
    }
    const otherAccount = manifest.accounts.find((item) => item.id !== nature.id)
    assert.equal(otherAccount.loginMode, 'manual')
    assert.notEqual(otherAccount.password.iv, storedNature.password.iv, 'each record must use a fresh IV')
    const keyFile = await stat(path.join(dataDir, 'secret.key'))
    assert.equal(keyFile.size, 32)
    assert.ok(!existsSync(path.join(dataDir, 'accounts.json.tmp')), 'temp file should be renamed away')
  })

  await test('manual accounts may omit the password; auto accounts still require a non-empty one', async () => {
    // e.g. a GitHub account created with Google sign-in has no site password at all.
    const manualNoPassword = await store.create({
      label: 'GitHub',
      url: 'https://github.com',
      username: 'octocat',
      loginMode: 'manual',
    })
    assert.equal(manualNoPassword.loginMode, 'manual')
    assert.ok(!('password' in manualNoPassword), 'AccountPublic must not contain password')
    assert.equal((await store.get(manualNoPassword.id)).password, '')
    const manualEmptyString = await store.create({
      label: 'GitHub-alt',
      url: 'https://github.com',
      username: 'octocat2',
      password: '',
      loginMode: 'manual',
    })
    assert.equal((await store.get(manualEmptyString.id)).password, '')
    // The empty password is persisted encrypted and decrypts after a reopen.
    const reopened = await createStore({ dir: dataDir })
    assert.equal((await reopened.get(manualNoPassword.id)).password, '')
    assert.equal((await reopened.get(manualEmptyString.id)).password, '')

    // auto (explicit or default) still rejects a missing / empty password.
    await expectRejection(() => store.create({ url: 'https://auto.test', username: 'u' }), 'INVALID_INPUT')
    await expectRejection(() => store.create({ url: 'https://auto.test', username: 'u', loginMode: 'auto' }), 'INVALID_INPUT')
    await expectRejection(() => store.create({ url: 'https://auto.test', username: 'u', password: '', loginMode: 'auto' }), 'INVALID_INPUT')

    // Switching a passwordless manual account to auto needs a password...
    await expectRejection(() => store.update(manualNoPassword.id, { loginMode: 'auto' }), 'INVALID_INPUT')
    // ...and succeeds once one is provided.
    const switched = await store.update(manualNoPassword.id, { loginMode: 'auto', password: 'Fresh#Pass-1' })
    assert.equal(switched.loginMode, 'auto')
    assert.equal((await store.get(manualNoPassword.id)).password, 'Fresh#Pass-1')
    // Switching back to manual keeps the existing password.
    const backToManual = await store.update(manualNoPassword.id, { loginMode: 'manual' })
    assert.equal(backToManual.loginMode, 'manual')
    assert.equal((await store.get(manualNoPassword.id)).password, 'Fresh#Pass-1')
  })

  await test('update() with an empty / null / missing password keeps the current password', async () => {
    const before = (await store.get(nature.id)).password
    const updated = await store.update(nature.id, { label: 'Nature', password: '' })
    assert.equal(updated.label, 'Nature')
    assert.equal(updated.loginMode, 'auto', 'omitting loginMode keeps the current value')
    assert.equal((await store.get(nature.id)).password, before)
    await store.update(nature.id, { password: null })
    assert.equal((await store.get(nature.id)).password, before)
    await store.update(nature.id, { notes: 'still here' })
    assert.equal((await store.get(nature.id)).password, before)
    assert.equal(updated.updatedAt <= new Date().toISOString(), true)
  })

  await test('update() switches loginMode between manual and auto; invalid values are rejected', async () => {
    const manual = await store.update(nature.id, { loginMode: 'manual' })
    assert.equal(manual.loginMode, 'manual')
    assert.equal((await store.get(nature.id)).loginMode, 'manual')
    // An unrelated update keeps the manual mode.
    const kept = await store.update(nature.id, { notes: 'mode kept' })
    assert.equal(kept.loginMode, 'manual')
    const backToAuto = await store.update(nature.id, { loginMode: 'auto' })
    assert.equal(backToAuto.loginMode, 'auto')
    assert.equal((await store.list()).find((account) => account.id === nature.id).loginMode, 'auto')
  })

  await test('update() rotates the password when a non-empty one is supplied', async () => {
    const updated = await store.update(nature.id, { password: NEW_PASSWORD })
    assert.ok(!('password' in updated))
    assert.equal((await store.get(nature.id)).password, NEW_PASSWORD)
    const manifestText = await readFile(path.join(dataDir, 'accounts.json'), 'utf8')
    assertNoSecrets(manifestText, 'accounts.json after rotation')
  })

  await test('create()/update() validate input with INVALID_INPUT', async () => {
    await expectRejection(() => store.create({ url: 'ftp://example.test', username: 'u', password: 'p' }), 'INVALID_INPUT')
    await expectRejection(() => store.create({ url: 'not a url', username: 'u', password: 'p' }), 'INVALID_INPUT')
    await expectRejection(() => store.create({ url: 'https://ok.test', username: '   ', password: 'p' }), 'INVALID_INPUT')
    await expectRejection(() => store.create({ url: 'https://ok.test', username: 'u', password: '' }), 'INVALID_INPUT')
    await expectRejection(() => store.create({ url: 'https://ok.test', username: 'u', password: 'p', searchUrl: 'https://ok.test/search' }), 'INVALID_INPUT')
    await expectRejection(() => store.create({ url: 'https://ok.test', username: 'u', password: 'p', loginMode: 'sso' }), 'INVALID_INPUT')
    await expectRejection(() => store.create({ url: 'https://ok.test', username: 'u', password: 'p', loginMode: 42 }), 'INVALID_INPUT')
    await expectRejection(() => store.update(nature.id, { username: '' }), 'INVALID_INPUT')
    await expectRejection(() => store.update(nature.id, { url: 'javascript:alert(1)' }), 'INVALID_INPUT')
    await expectRejection(() => store.update(nature.id, { loginMode: 'bogus' }), 'INVALID_INPUT')
    await expectRejection(() => store.update(nature.id, { loginMode: '' }), 'INVALID_INPUT')
    await expectRejection(() => store.update('acc_missing', { label: 'x' }), 'NOT_FOUND')
  })

  await test('setSession() merges patches, keeps other fields, and tolerates unknown ids', async () => {
    const stamp = new Date().toISOString()
    const publicAccount = await store.setSession(nature.id, { status: 'authenticated', lastLoginAt: stamp })
    assert.equal(publicAccount.session.status, 'authenticated')
    assert.equal(publicAccount.session.lastLoginAt, stamp)
    const detail = await store.setSession(nature.id, { detail: 'ok' })
    assert.equal(detail.session.status, 'authenticated')
    assert.equal(detail.session.detail, 'ok')
    assert.equal(await store.setSession('acc_missing', { status: 'authenticated' }), undefined)
    await expectRejection(() => store.setSession(nature.id, { status: 'nonsense' }), 'INVALID_INPUT')
  })

  await test('a second store on the same directory decrypts existing records', async () => {
    const reopened = await createStore({ dir: dataDir })
    const accounts = await reopened.list()
    assert.equal(accounts.length, (await store.list()).length)
    const record = await reopened.get(nature.id)
    assert.equal(record.password, NEW_PASSWORD)
    assert.equal(record.loginMode, 'auto')
  })

  await test('a legacy accounts.json without loginMode loads as auto and is upgraded on write', async () => {
    const legacyDir = await makeTempDir('legacy-mode')
    const legacyStore = await createStore({ dir: legacyDir })
    const created = await legacyStore.create({ label: 'Legacy', url: 'https://legacy.test', username: 'u', password: PASSWORD })
    const legacyFile = path.join(legacyDir, 'accounts.json')
    const legacyManifest = JSON.parse(await readFile(legacyFile, 'utf8'))
    delete legacyManifest.accounts[0].loginMode
    await writeFile(legacyFile, JSON.stringify(legacyManifest, null, 2), 'utf8')

    const reopened = await createStore({ dir: legacyDir })
    const [account] = await reopened.list()
    assert.equal(account.id, created.id)
    assert.equal(account.loginMode, 'auto', 'missing loginMode must load as auto')
    const record = await reopened.get(created.id)
    assert.equal(record.loginMode, 'auto')
    assert.equal(record.password, PASSWORD, 'legacy migration must not break decryption')

    // The next write persists the upgraded field.
    await reopened.update(created.id, { loginMode: 'manual' })
    const upgraded = JSON.parse(await readFile(legacyFile, 'utf8'))
    assert.equal(upgraded.accounts[0].loginMode, 'manual')
  })

  await test('concurrent create() calls are serialized without losing records', async () => {
    const before = (await store.list()).length
    const created = await Promise.all(
      Array.from({ length: 6 }, (_unused, index) =>
        store.create({ url: `https://bulk-${index}.example.test`, username: `bulk-${index}`, password: PASSWORD }),
      ),
    )
    const after = await store.list()
    assert.equal(after.length, before + created.length)
    assert.equal(new Set(created.map((item) => item.id)).size, created.length)
    for (const account of created) await store.remove(account.id)
    assert.equal((await store.list()).length, before)
  })

  await test('remove() deletes the record and reports NOT_FOUND afterwards', async () => {
    const temporary = await store.create({ url: 'https://delete-me.test', username: 'u', password: PASSWORD })
    await store.remove(temporary.id)
    assert.equal(await store.get(temporary.id), undefined)
    await expectRejection(() => store.remove(temporary.id), 'NOT_FOUND')
  })

  await test('a corrupt accounts.json degrades to an empty list and recovers on the next write', async () => {
    const corruptDir = await makeTempDir('corrupt')
    await mkdir(corruptDir, { recursive: true })
    await writeFile(path.join(corruptDir, 'accounts.json'), '{{{ definitely not json', 'utf8')
    const originalWarn = console.warn
    console.warn = () => {}
    let corruptStore
    try {
      corruptStore = await createStore({ dir: corruptDir })
    } finally {
      console.warn = originalWarn
    }
    assert.deepEqual(await corruptStore.list(), [])
    const revived = await corruptStore.create({ url: 'https://revived.test', username: 'u', password: PASSWORD })
    const accounts = await corruptStore.list()
    assert.equal(accounts.length, 1)
    assert.equal(accounts[0].id, revived.id)
  })

  await test('an unreadable secret.key length warning path still produces a usable store', async () => {
    const keyDir = await makeTempDir('badkey')
    await writeFile(path.join(keyDir, 'secret.key'), 'short', 'utf8')
    const originalWarn = console.warn
    console.warn = () => {}
    let keyStore
    try {
      keyStore = await createStore({ dir: keyDir })
    } finally {
      console.warn = originalWarn
    }
    const created = await keyStore.create({ url: 'https://key.test', username: 'u', password: PASSWORD })
    assert.equal((await keyStore.get(created.id)).password, PASSWORD)
    assert.equal((await stat(path.join(keyDir, 'secret.key'))).size, 32)
  })

  return { dataDir, store }
}

async function runServiceTests({ store }) {
  section('accountService: operations & error codes')
  const browser = createFakeBrowserManager({ store })
  const service = createAccountService({ store, browser, log: () => {} })
  const accounts = await store.list()
  const primary = accounts.find((account) => account.label === 'Nature')
  const secondary = accounts.find((account) => account.label === 'Science')

  await test('state() exposes accounts (with loginMode), pending, browser availability and pending count', async () => {
    const state = await service.state()
    assert.ok(Array.isArray(state.accounts))
    assert.equal(state.pending, null)
    assert.equal(state.browser.available, true)
    assert.equal(typeof state.browser.executablePath, 'string')
    assert.equal(state.browserPendingCount, 0)
    assert.equal(state.accounts.find((account) => account.id === primary.id).loginMode, 'auto')
    assert.equal(state.accounts.find((account) => account.id === secondary.id).loginMode, 'manual')
    const listed = await service.list()
    assert.deepEqual(
      listed.map((account) => account.loginMode),
      state.accounts.map((account) => account.loginMode),
      'service.list() and state().accounts expose the same loginMode values',
    )
    assertNoSecrets(state.accounts, 'service.state().accounts')
  })

  await test('resolveAccount() resolves id and case-insensitive label; reports NOT_FOUND', async () => {
    assert.equal((await service.resolveAccount(primary.id)).id, primary.id)
    assert.equal((await service.resolveAccount('  nature ')).id, primary.id)
    assert.ok(!('password' in (await service.resolveAccount(primary.id))), 'resolveAccount must return AccountPublic')
    await expectRejection(() => service.resolveAccount('no-such-account'), 'NOT_FOUND')
    await expectRejection(() => service.resolveAccount(''), 'INVALID_INPUT')
  })

  await test('resolveAccount() reports AMBIGUOUS for duplicate labels', async () => {
    const first = await service.create({ label: 'DupSite', url: 'https://dup-1.test', username: 'u1', password: PASSWORD })
    const second = await service.create({ label: 'DupSite', url: 'https://dup-2.test', username: 'u2', password: PASSWORD })
    await expectRejection(() => service.resolveAccount('dupsite'), 'AMBIGUOUS')
    await service.remove(first.id)
    await service.remove(second.id)
  })

  await test('login() starts a flow, flips the session and reports busy afterwards', async () => {
    const result = await service.login(primary.id)
    assert.equal(result.status, 'started')
    assert.ok(result.message.length > 0)
    assert.equal(result.pending.phase, 'verification-required')
    const listed = (await service.list()).find((account) => account.id === primary.id)
    assert.equal(listed.session.status, 'verification-required')
    const state = await service.state()
    assert.ok(state.pending, 'state.pending should be set during verification')
    assert.equal(state.browserPendingCount, 1)
    const busy = await service.login(primary.id)
    assert.equal(busy.status, 'busy')
    await expectRejection(() => service.login('acc_missing'), 'NOT_FOUND')
  })

  await test('confirmLogin() saves the session and clears pending', async () => {
    const result = await service.confirmLogin(primary.id)
    assert.equal(result.status, 'authenticated')
    assert.equal((await service.state()).pending, null)
    const listed = (await service.list()).find((account) => account.id === primary.id)
    assert.equal(listed.session.status, 'authenticated')
    assert.match(listed.session.lastLoginAt, /^\d{4}-\d{2}-\d{2}T/)
  })

  await test('cancelLogin() clears pending and returns cancelled', async () => {
    const started = await service.login(secondary.id)
    assert.equal(started.status, 'started')
    const cancelled = await service.cancelLogin(secondary.id)
    assert.equal(cancelled.status, 'cancelled')
    assert.equal((await service.state()).pending, null)
  })

  await test('test() returns the page title/url/textSnippet capped at 300 chars', async () => {
    const result = await service.test(primary.id)
    assert.equal(result.status, 'ok')
    assert.ok(result.title.length > 0)
    assert.equal(result.url, primary.url)
    assert.ok(result.textSnippet.length > 0)
    assert.ok(result.textSnippet.length <= 300)
  })

  await test('fetch() and search() delegate to the browser manager', async () => {
    const fetched = await service.fetch(primary.id, 'https://www.nature.com/articles/xyz')
    assert.equal(fetched.status, 'ok')
    assert.equal(fetched.url, 'https://www.nature.com/articles/xyz')
    const searched = await service.search(primary.id, 'crispr cas9')
    assert.equal(searched.status, 'ok')
    assert.equal(searched.usedUrl, 'https://www.nature.com/search?q=crispr%20cas9')
    assert.equal(searched.guessed, false)
  })

  await test('fetch()/search() validate input', async () => {
    await expectRejection(() => service.fetch(primary.id, 'file:///etc/passwd'), 'INVALID_INPUT')
    await expectRejection(() => service.fetch(primary.id, ''), 'INVALID_INPUT')
    await expectRejection(() => service.fetch('acc_missing', 'https://ok.test'), 'NOT_FOUND')
    await expectRejection(() => service.search(primary.id, '   '), 'INVALID_INPUT')
    await expectRejection(() => service.search(primary.id, 'x', { maxChars: 0 }), 'INVALID_INPUT')
  })

  await test('remove() cancels the browser, drops the profile and the record', async () => {
    const temporary = await service.create({ label: 'TempDelete', url: 'https://temp-delete.test', username: 'u', password: PASSWORD })
    await service.login(temporary.id)
    await service.remove(temporary.id)
    const after = await service.list()
    assert.ok(!after.some((account) => account.id === temporary.id), 'removed account still listed')
    const inspect = browser._inspect()
    assert.ok(inspect.removedProfiles.includes(temporary.id), 'browser.removeProfile was not called')
    assert.equal(inspect.pending, null)
  })

  await test('close() closes every browser window', async () => {
    const before = browser._inspect().closeAllCalls
    await service.close()
    assert.equal(browser._inspect().closeAllCalls, before + 1)
  })

  return { service, browser }
}

async function runToolTests({ service }) {
  section('agent tools: definitions & execute')
  const ctx = createFakeCtx({ withWebServer: false })
  const dispose = registerTools(ctx, service, { log: () => {} })

  await test('registerTools() registers the four fixed tools', async () => {
    assert.deepEqual([...ctx._tools.keys()].sort(), [
      'account_hub_fetch',
      'account_hub_list',
      'account_hub_login',
      'account_hub_search',
    ])
    for (const definition of ctx._tools.values()) {
      assert.equal(typeof definition.description, 'string')
      assert.ok(definition.description.length > 40, `${definition.name} description is too short`)
      assert.equal(definition.parameters.type, 'object')
      assert.equal(definition.output.schema.type, 'object')
      assert.equal(typeof definition.output.render, 'function')
      assert.equal(typeof definition.execute, 'function')
      assert.equal(typeof definition.timeoutMs, 'number')
      assert.equal(typeof definition.isConcurrencySafe, 'function')
    }
    assert.equal(ctx._tools.get('account_hub_list').isConcurrencySafe({}), true)
    assert.equal(ctx._tools.get('account_hub_search').isConcurrencySafe({}), false)
    assert.equal(ctx._tools.get('account_hub_fetch').isConcurrencySafe({}), false)
    assert.equal(ctx._tools.get('account_hub_login').isConcurrencySafe({}), false)
  })

  await test('account_hub_list executes without args and returns sanitized accounts with loginMode', async () => {
    const definition = ctx._tools.get('account_hub_list')
    const value = await definition.execute({}, {})
    assert.equal(typeof value, 'object')
    assert.ok(Array.isArray(value.accounts) && value.accounts.length >= 2)
    for (const account of value.accounts) {
      assert.equal(typeof account.id, 'string')
      assert.equal(typeof account.label, 'string')
      assert.equal(typeof account.url, 'string')
      assert.equal(typeof account.username, 'string')
      assert.equal(typeof account.sessionStatus, 'string')
      assert.ok(['auto', 'manual'].includes(account.loginMode), `unexpected loginMode: ${account.loginMode}`)
      assert.ok(!('password' in account), 'tool result leaked password')
    }
    assert.equal(value.accounts.find((account) => account.label === 'Nature').loginMode, 'auto')
    assert.equal(value.accounts.find((account) => account.label === 'Science').loginMode, 'manual')
    assert.equal(value.pending, null)
    assert.equal(value.browserAvailable, true)
    assertNoSecrets(value, 'account_hub_list result')
    assert.ok(!definition.output.render({}, value)[0].text.includes(PASSWORD))
    assert.equal(definition.output.render({}, value)[0].type, 'text')
  })

  await test('account_hub_search resolves labels and returns the browser result', async () => {
    const definition = ctx._tools.get('account_hub_search')
    const value = await definition.execute({ account: 'nature', query: 'crispr', maxChars: 4000 }, {})
    assert.equal(value.status, 'ok')
    assert.equal(value.usedUrl, 'https://www.nature.com/search?q=crispr')
    assert.ok(value.text.includes('crispr'))
    assert.ok(Array.isArray(value.links))
    assertNoSecrets(value, 'account_hub_search result')
  })

  await test('account_hub_fetch returns page content for authenticated URLs', async () => {
    const definition = ctx._tools.get('account_hub_fetch')
    const value = await definition.execute({ account: 'Science', url: 'https://www.science.org/doi/10.1126/science.abc' }, {})
    assert.equal(value.status, 'ok')
    assert.ok(value.text.includes('Science'))
    assert.ok(!('password' in value))
  })

  await test('account_hub_fetch surfaces verification-required with a pending handoff', async () => {
    const fetchTool = ctx._tools.get('account_hub_fetch')
    const value = await fetchTool.execute({ account: 'Nature', url: 'https://www.nature.com/challenge' }, {})
    assert.equal(value.status, 'verification-required')
    assert.ok(value.pending && value.pending.accountId, 'verification result must include pending')
    assert.equal(typeof value.challenge.kind, 'string')
    assert.ok(value.message && value.message.length > 0)
    assertNoSecrets(value, 'verification result')
  })

  await test('account_hub_login opens the visible window and reports loginMode (auto vs manual)', async () => {
    const listed = await service.list()
    const primary = listed.find((account) => account.label === 'Nature')
    const manualAccount = listed.find((account) => account.label === 'Science')
    const loginTool = ctx._tools.get('account_hub_login')
    // The account is still marked busy by the challenge fetch above.
    const busyValue = await loginTool.execute({ account: primary.id }, {})
    assert.equal(busyValue.status, 'busy')
    assert.equal(busyValue.loginMode, 'auto')
    await service.cancelLogin(primary.id)
    const started = await loginTool.execute({ account: primary.label }, {})
    assert.equal(started.status, 'started')
    assert.equal(started.loginMode, 'auto')
    assert.ok(started.message.length > 0)
    assert.ok(started.pending && started.pending.phase)
    await service.confirmLogin(primary.id)

    // A manual-mode account (e.g. GitHub signed up with Google/passkey): the result says
    // no autofill happens and tells the user to complete it by hand.
    const manualStarted = await loginTool.execute({ account: manualAccount.id }, {})
    assert.equal(manualStarted.status, 'started')
    assert.equal(manualStarted.loginMode, 'manual')
    assert.ok(manualStarted.message.includes('手动'), `manual message missing hint: ${manualStarted.message}`)
    assert.ok(/Google|passkey/i.test(manualStarted.message))
    assert.ok(manualStarted.pending && manualStarted.pending.phase)
    await service.cancelLogin(manualAccount.id)
  })

  await test('tool errors come back as {status:error,error:{code,message}} and never throw', async () => {
    const cases = [
      [ctx._tools.get('account_hub_search'), { account: 'no-such', query: 'x' }, 'NOT_FOUND'],
      [ctx._tools.get('account_hub_fetch'), { account: 'Nature' }, 'INVALID_INPUT'],
      [ctx._tools.get('account_hub_search'), {}, 'INVALID_INPUT'],
      [ctx._tools.get('account_hub_login'), { account: '' }, 'INVALID_INPUT'],
      [ctx._tools.get('account_hub_fetch'), { account: 'Nature', url: 'https://x.test/boom' }, 'INTERNAL'],
      [ctx._tools.get('account_hub_search'), { account: 'Nature', query: 'x', maxChars: -5 }, 'INVALID_INPUT'],
    ]
    for (const [definition, args, expectedCode] of cases) {
      const value = await definition.execute(args, {})
      assert.equal(value.status, 'error', `${definition.name}: expected status error`)
      assert.equal(value.error.code, expectedCode, `${definition.name}: wrong error code`)
      assert.ok(value.error.message.length > 0)
      assertNoSecrets(value, `${definition.name} error result`)
    }
  })

  await test('tool results are JSON-serializable and every render returns text blocks', async () => {
    for (const definition of ctx._tools.values()) {
      const value = await definition.execute({ account: 'Nature', query: 'x', url: 'https://www.nature.com/x' }, {}).catch(() => undefined)
      if (value === undefined) continue
      assert.doesNotThrow(() => JSON.stringify(value), `${definition.name} result is not JSON-serializable`)
      const blocks = definition.output.render({}, value)
      assert.ok(Array.isArray(blocks) && blocks.length > 0)
      assert.equal(blocks[0].type, 'text')
      assert.equal(typeof blocks[0].text, 'string')
    }
    // The loop above may start a login flow through account_hub_login; leave no pending
    // state behind for the route tests that follow.
    const pending = (await service.state()).pending
    if (pending && pending.accountId) await service.cancelLogin(pending.accountId)
  })

  await test('dispose() unregisters every tool exactly once', async () => {
    assert.equal(typeof dispose, 'function')
    dispose()
    dispose()
    assert.equal(ctx._tools.size, 0)
  })

  await test('registerTools() degrades gracefully without a tools service', async () => {
    const bareCtx = createFakeCtx({ withTools: false })
    const originalWarn = console.warn
    console.warn = () => {}
    try {
      const noop = registerTools(bareCtx, service, { log: () => {} })
      assert.equal(typeof noop, 'function')
      assert.equal(bareCtx._tools.size, 0)
    } finally {
      console.warn = originalWarn
    }
  })
}

async function runRouteTests({ service, store }) {
  section('HTTP routes: envelopes, status codes, body limits')
  const ctx = createFakeCtx()
  const dispose = registerRoutes(ctx, service, { log: () => {} })

  const expectedPaths = [
    '/api/account-hub/accounts',
    '/api/account-hub/accounts/delete',
    '/api/account-hub/accounts/update',
    '/api/account-hub/fetch',
    '/api/account-hub/login',
    '/api/account-hub/login/cancel',
    '/api/account-hub/login/confirm',
    '/api/account-hub/search',
    '/api/account-hub/state',
    '/api/account-hub/test',
  ]

  await test('registerRoutes() registers 10 exact paths covering the 11 contract endpoints', async () => {
    assert.equal(ENDPOINT_COUNT, 11, 'route table must cover 11 method+path endpoints')
    assert.equal(ctx._routes.size, expectedPaths.length)
    for (const routePath of expectedPaths) assert.ok(ctx._routes.has(`exact:${routePath}`), `missing route ${routePath}`)
  })

  await test('GET /state returns accounts (with loginMode) + pending + browser without secrets', async () => {
    const res = await callRoute(ctx, 'GET', '/api/account-hub/state')
    assert.equal(res.statusCode, 200)
    const data = assertOk(res, 'GET /state')
    assert.ok(Array.isArray(data.accounts))
    for (const account of data.accounts) assert.ok(['auto', 'manual'].includes(account.loginMode))
    assert.equal(data.pending, null)
    assert.equal(typeof data.browser.available, 'boolean')
    assertNoSecrets(data, 'GET /state data')
  })

  await test('GET /accounts returns an AccountPublic array that includes loginMode', async () => {
    const data = assertOk(await callRoute(ctx, 'GET', '/api/account-hub/accounts'), 'GET /accounts')
    assert.ok(Array.isArray(data) && data.length >= 2)
    for (const account of data) {
      assert.ok(!('password' in account))
      assert.ok(['auto', 'manual'].includes(account.loginMode), `route list missing loginMode: ${JSON.stringify(account.loginMode)}`)
    }
    assert.equal(data.find((account) => account.label === 'Science').loginMode, 'manual')
  })

  let createdId
  await test('POST /accounts creates an account with loginMode through the route', async () => {
    const data = assertOk(
      await callRoute(ctx, 'POST', '/api/account-hub/accounts', {
        label: 'RouteCreated',
        url: 'https://route-created.test',
        username: 'route-user',
        password: PASSWORD,
        loginMode: 'manual',
      }),
      'POST /accounts',
    )
    createdId = data.id
    assert.match(data.id, /^acc_[0-9a-f]{12}$/)
    assert.equal(data.label, 'RouteCreated')
    assert.equal(data.loginMode, 'manual', 'create route must pass loginMode through')
    assert.equal((await service.list()).find((account) => account.id === createdId).loginMode, 'manual')
  })

  await test('POST /accounts creates a manual account without a password', async () => {
    const data = assertOk(
      await callRoute(ctx, 'POST', '/api/account-hub/accounts', {
        label: 'RouteManualNoPw',
        url: 'https://route-manual.test',
        username: 'route-google-user',
        loginMode: 'manual',
      }),
      'POST /accounts manual/no password',
    )
    assert.equal(data.loginMode, 'manual')
    assert.ok(!('password' in data))
    assert.equal((await store.get(data.id)).password, '')
    await service.remove(data.id)
  })

  await test('POST /accounts/update keeps the password and switches loginMode back to auto', async () => {
    const data = assertOk(
      await callRoute(ctx, 'POST', '/api/account-hub/accounts/update', { id: createdId, label: 'RouteUpdated', loginMode: 'auto' }),
      'POST /accounts/update',
    )
    assert.equal(data.label, 'RouteUpdated')
    assert.equal(data.loginMode, 'auto', 'update route must pass loginMode through')
    assert.equal((await service.list()).find((account) => account.id === createdId).loginMode, 'auto')
  })

  await test('POST /accounts/update rejects invalid input with 400', async () => {
    const res = await callRoute(ctx, 'POST', '/api/account-hub/accounts/update', { id: createdId, url: 'not-a-url' })
    assertFail(res, 'INVALID_INPUT', 400, 'update invalid')
  })

  await test('POST /accounts/delete removes the account and answers {deleted:true}', async () => {
    const data = assertOk(await callRoute(ctx, 'POST', '/api/account-hub/accounts/delete', { id: createdId }), 'delete')
    assert.deepEqual(data, { deleted: true })
    const list = assertOk(await callRoute(ctx, 'GET', '/api/account-hub/accounts'), 'list after delete')
    assert.ok(!list.some((account) => account.id === createdId))
  })

  const primary = (await service.list()).find((account) => account.label === 'Nature')

  await test('POST /login, /login/confirm and /login/cancel drive the human-verification handoff', async () => {
    const loginRes = await callRoute(ctx, 'POST', '/api/account-hub/login', { id: primary.id })
    assert.equal(loginRes.statusCode, 200)
    const loginData = assertOk(loginRes, 'POST /login')
    assert.equal(loginData.status, 'started')
    assert.ok(loginData.pending, 'login response should include pending')
    assert.ok(loginData.message.length > 0)

    const confirmData = assertOk(await callRoute(ctx, 'POST', '/api/account-hub/login/confirm', { id: primary.id }), 'confirm')
    assert.equal(confirmData.status, 'authenticated')

    assert.equal((await service.login(primary.id)).status, 'started')
    const cancelData = assertOk(await callRoute(ctx, 'POST', '/api/account-hub/login/cancel', { id: primary.id }), 'cancel')
    assert.equal(cancelData.status, 'cancelled')
  })

  await test('POST /test returns the session probe payload', async () => {
    const data = assertOk(await callRoute(ctx, 'POST', '/api/account-hub/test', { id: primary.id }), 'POST /test')
    assert.equal(data.status, 'ok')
    assert.ok(data.title.length > 0)
    assert.ok(typeof data.textSnippet === 'string')
  })

  await test('POST /fetch returns authenticated page text; /search returns results + usedUrl', async () => {
    const fetched = assertOk(
      await callRoute(ctx, 'POST', '/api/account-hub/fetch', { id: primary.id, url: 'https://www.nature.com/articles/one', maxChars: 5000 }),
      'POST /fetch',
    )
    assert.equal(fetched.status, 'ok')
    assert.equal(fetched.url, 'https://www.nature.com/articles/one')
    const searched = assertOk(
      await callRoute(ctx, 'POST', '/api/account-hub/search', { id: primary.id, query: 'genome editing' }),
      'POST /search',
    )
    assert.equal(searched.status, 'ok')
    assert.ok(searched.usedUrl.includes('genome%20editing'))
    const challenge = assertOk(
      await callRoute(ctx, 'POST', '/api/account-hub/fetch', { id: primary.id, url: 'https://www.nature.com/challenge' }),
      'POST /fetch challenge',
    )
    assert.equal(challenge.status, 'verification-required')
    await callRoute(ctx, 'POST', '/api/account-hub/login/cancel', { id: primary.id })
  })

  await test('wrong method answers 405 with a JSON envelope and Allow header', async () => {
    const res = await callRoute(ctx, 'GET', '/api/account-hub/login')
    assertFail(res, 'METHOD_NOT_ALLOWED', 405, 'GET /login')
    assert.equal(res.headers.allow, 'POST')
    const res2 = await callRoute(ctx, 'DELETE', '/api/account-hub/state')
    assertFail(res2, 'METHOD_NOT_ALLOWED', 405, 'DELETE /state')
    assert.equal(res2.headers.allow, 'GET')
    const res3 = await callRoute(ctx, 'PUT', '/api/account-hub/accounts')
    assertFail(res3, 'METHOD_NOT_ALLOWED', 405, 'PUT /accounts')
    assert.equal(res3.headers.allow, 'GET, POST')
    const res4 = await callRoute(ctx, 'GET', '/api/account-hub/accounts')
    assert.equal(res4.statusCode, 200, 'GET /accounts must stay a valid GET route')
  })

  await test('broken JSON body answers 400 INVALID_JSON', async () => {
    const res = await callRoute(ctx, 'POST', '/api/account-hub/accounts', '{ not valid json')
    assertFail(res, 'INVALID_JSON', 400, 'invalid json')
  })

  await test('request bodies above 64 KiB answer 413 PAYLOAD_TOO_LARGE', async () => {
    const oversized = JSON.stringify({ url: 'https://ok.test', username: 'u', password: PASSWORD, notes: 'x'.repeat(70 * 1024) })
    const res = await callRoute(ctx, 'POST', '/api/account-hub/accounts', oversized)
    assertFail(res, 'PAYLOAD_TOO_LARGE', 413, 'oversized body')
  })

  await test('unknown account id answers 404 NOT_FOUND', async () => {
    const res = await callRoute(ctx, 'POST', '/api/account-hub/accounts/delete', { id: 'acc_0123456789ab' })
    assertFail(res, 'NOT_FOUND', 404, 'delete missing')
    const res2 = await callRoute(ctx, 'POST', '/api/account-hub/login', {})
    assertFail(res2, 'INVALID_INPUT', 400, 'login without id')
  })

  await test('HEAD is accepted on GET routes', async () => {
    const res = await callRoute(ctx, 'HEAD', '/api/account-hub/state')
    assert.equal(res.statusCode, 200)
    assert.equal(assertOk(res, 'HEAD /state') !== undefined, true)
  })

  await test('dispose() removes every route from the webServer', async () => {
    assert.equal(typeof dispose, 'function')
    dispose()
    dispose()
    assert.equal(ctx._routes.size, 0)
  })

  await test('registerRoutes() degrades gracefully when webServer is unavailable or failing', async () => {
    const originalWarn = console.warn
    const originalError = console.error
    console.warn = () => {}
    console.error = () => {}
    try {
      const noServer = createFakeCtx({ withWebServer: false })
      const noop = registerRoutes(noServer, service, { log: () => {} })
      assert.equal(typeof noop, 'function')
      assert.equal(noServer._routes.size, 0)

      const failing = createFakeCtx({ failRegister: true })
      const failed = registerRoutes(failing, service, { log: () => {} })
      assert.equal(typeof failed, 'function')
      assert.equal(failing._routes.size, 0)
    } finally {
      console.warn = originalWarn
      console.error = originalError
    }
  })
}

async function runIndexTests() {
  section('index.js: plugin assembly (optional, needs lib/browser.js)')
  const browserModulePath = path.join(PLUGIN_ROOT, 'lib', 'browser.js')
  if (!existsSync(browserModulePath)) {
    console.log('SKIP  index.js assembly tests — lib/browser.js is not delivered yet')
    return
  }
  const indexModule = await import(pathToFileURL(path.join(PLUGIN_ROOT, 'index.js')).href)
  assert.equal(typeof indexModule.apply, 'function')
  assert.deepEqual(indexModule.inject, ['tools'])

  const dataDir = await makeTempDir('index')
  const ctx = createFakeCtx({ withWebServer: true, withTools: true, withSystemPrompt: true })
  const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  const config = existsSync(edgePath) ? { dataDir, browserPath: edgePath } : { dataDir }

  // Hide plugin warnings during assembly (index.js logs its readiness to stdout, which we keep).
  const originalWarn = console.warn
  console.warn = () => {}
  try {
    await test('apply() registers 10 route paths, 4 tools and one system-prompt section', async () => {
      indexModule.apply(ctx, config)
      await waitFor(() => ctx._tools.size === 4 && ctx._routes.size === 10, { label: 'index.js init' })
      await waitFor(() => ctx._prompt.sections.length === 1, { label: 'prompt section' })
      assert.equal(ctx._tools.size, 4)
      assert.equal(ctx._routes.size, 10)
      assert.equal(ctx._prompt.sections[0].name, 'account-hub')
      assert.equal(typeof ctx._prompt.sections[0].order, 'number')
    })

    await test('the system-prompt section lists accounts after creation and never leaks passwords', async () => {
      assert.equal(ctx._prompt.sections[0].text(), '', 'no accounts yet => empty prompt text')
      const res = await callRoute(ctx, 'POST', '/api/account-hub/accounts', {
        label: 'PromptVisible',
        url: 'https://prompt-visible.test',
        username: 'u',
        password: PASSWORD,
      })
      assertOk(res, 'index POST /accounts')
      await waitFor(() => ctx._prompt.sections[0].text().includes('PromptVisible'), { label: 'prompt text refresh' })
      const promptText = ctx._prompt.sections[0].text()
      assertNoSecrets(promptText, 'system prompt section')
      assert.ok(promptText.includes('account_hub_search'))
    })

    await test('tool execute works through the assembled plugin', async () => {
      const definition = ctx._tools.get('account_hub_list')
      const value = await definition.execute({}, {})
      assert.ok(value.accounts.some((account) => account.label === 'PromptVisible'))
      assertNoSecrets(value, 'index tool result')
    })

    await test('unloading the plugin disposes tools, routes, prompt section and closes browsers', async () => {
      ctx._disposeAll()
      assert.equal(ctx._tools.size, 0)
      assert.equal(ctx._routes.size, 0)
      assert.equal(ctx._prompt.sections.length, 0)
      await new Promise((resolve) => setTimeout(resolve, 50))
    })

    await test('a failing store init is logged, not thrown', async () => {
      const brokenDir = await makeTempDir('index-broken')
      const filePath = path.join(brokenDir, 'not-a-directory')
      await writeFile(filePath, 'x', 'utf8')
      const brokenCtx = createFakeCtx()
      const capturedErrors = []
      const originalError = console.error
      console.error = (...args) => capturedErrors.push(args.map((value) => String(value)).join(' '))
      try {
        assert.doesNotThrow(() => indexModule.apply(brokenCtx, { dataDir: filePath }))
        await waitFor(() => capturedErrors.some((line) => line.includes('初始化失败')), { label: 'init failure log' })
      } finally {
        console.error = originalError
      }
      assert.equal(brokenCtx._tools.size, 0)
      assert.equal(brokenCtx._routes.size, 0)
    })
  } finally {
    console.warn = originalWarn
  }
}

async function main() {
  console.log(`dsh-account-hub host-service test (node ${process.version})`)
  try {
    const storeContext = await runStoreTests()
    const serviceContext = await runServiceTests(storeContext)
    await runToolTests(serviceContext)
    await runRouteTests({ ...serviceContext, store: storeContext.store })
    await runIndexTests()
  } finally {
    for (const dir of tempDirs) {
      try {
        await rm(dir, { recursive: true, force: true })
      } catch {
        /* ignore cleanup failures */
      }
    }
    console.log(`\n${passed} passed, ${failures.length} failed`)
    if (failures.length > 0) {
      for (const failure of failures) console.error(`FAILED: ${failure.name}`)
      process.exitCode = 1
    } else {
      process.exitCode = 0
    }
  }
}

main().catch((error) => {
  console.error('FATAL', error)
  process.exitCode = 1
})
