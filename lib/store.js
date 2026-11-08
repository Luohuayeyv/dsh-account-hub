/**
 * dsh-account-hub — encrypted local account store.
 *
 * Persistence layout (inside <dir>):
 *   secret.key     32 random bytes, the AES-256-GCM key (mode 0600 when the OS allows it)
 *   accounts.json  { version: 1, accounts: [ { ...AccountPublic, password: { algo, iv, tag, data } } ] }
 *
 * Guarantees:
 *  - Passwords are never written to disk in plaintext; every public projection omits them.
 *  - Every write runs through one promise queue, so concurrent read-modify-write cycles
 *    (create/update/remove/setSession) cannot interleave and lose data.
 *  - Writes are atomic: serialize to `accounts.json.tmp`, then rename over the data file.
 *  - A corrupt data file degrades to an empty account list with a console.warn instead of
 *    failing plugin startup.
 *
 * This module only uses Node builtins (node:fs, node:crypto, node:path) and is Agent-agnostic.
 */

import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import path from 'node:path'

const LOG_PREFIX = '[account-hub]'
const FILE_VERSION = 1
const ALGO = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12
const DATA_FILE = 'accounts.json'
const KEY_FILE = 'secret.key'

const SESSION_STATUSES = new Set(['unknown', 'authenticated', 'expired', 'verification-required', 'error'])

/** Login modes: `auto` fills the login form, `manual` only opens a visible window. */
const LOGIN_MODES = new Set(['auto', 'manual'])
const DEFAULT_LOGIN_MODE = 'auto'

/** Create an Error carrying a machine-readable `code` used across the Host layers. */
export function hubError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nowIso() {
  return new Date().toISOString()
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Parse a required http(s) URL, returning the trimmed text plus its hostname
 * (used as the default label). Never leaks the value into error messages beyond
 * the offending text the caller already supplied.
 */
function parseRequiredUrl(raw, fieldLabel) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) throw hubError('INVALID_INPUT', `${fieldLabel}不能为空`)
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    throw hubError('INVALID_INPUT', `${fieldLabel}不是有效网址：${text}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw hubError('INVALID_INPUT', `${fieldLabel}只支持 http 或 https 网址`)
  }
  return { url: text, hostname: parsed.hostname }
}

function parseOptionalUrl(raw, fieldLabel) {
  if (raw === undefined || raw === null || raw === '') return ''
  return parseRequiredUrl(raw, fieldLabel).url
}

function parseSearchUrl(raw) {
  if (raw === undefined || raw === null || raw === '') return ''
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) return ''
  if (!text.includes('{query}')) throw hubError('INVALID_INPUT', '搜索地址模板必须包含 {query} 占位符')
  if (!isHttpUrl(text.replaceAll('{query}', 'query'))) {
    throw hubError('INVALID_INPUT', `搜索地址模板不是有效网址：${text}`)
  }
  return text
}

function parseRequiredText(raw, fieldLabel) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) throw hubError('INVALID_INPUT', `${fieldLabel}不能为空`)
  return text
}

function parsePassword(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw hubError('INVALID_INPUT', '密码不能为空')
  }
  return raw
}

/**
 * Password validation depends on the login mode: manual accounts (Google / Apple /
 * passkey sign-ins) often have no site password at all and may omit it, while auto
 * accounts need a non-empty password for the form-filling login flow.
 */
function parsePasswordForCreate(raw, loginMode) {
  if (loginMode === DEFAULT_LOGIN_MODE) return parsePassword(raw)
  if (raw === undefined || raw === null) return ''
  if (typeof raw !== 'string') throw hubError('INVALID_INPUT', '密码必须是字符串')
  return raw
}

const LOGIN_MODE_HINT = '登录方式只支持 auto（自动填表）或 manual（手动登录）'

/**
 * Validate a loginMode value. `fallback` is returned for a missing value
 * (undefined / null / empty string); without a fallback those are rejected.
 */
function parseLoginMode(raw, fallback = null) {
  if (raw === undefined || raw === null || raw === '') {
    if (fallback !== null) return fallback
    throw hubError('INVALID_INPUT', LOGIN_MODE_HINT)
  }
  if (typeof raw !== 'string') throw hubError('INVALID_INPUT', LOGIN_MODE_HINT)
  const value = raw.trim().toLowerCase()
  if (!LOGIN_MODES.has(value)) throw hubError('INVALID_INPUT', LOGIN_MODE_HINT)
  return value
}

function normalizeSession(input) {
  const source = isPlainObject(input) ? input : {}
  const status = typeof source.status === 'string' && SESSION_STATUSES.has(source.status) ? source.status : 'unknown'
  const session = { status }
  if (typeof source.lastLoginAt === 'string') session.lastLoginAt = source.lastLoginAt
  if (typeof source.lastCheckedAt === 'string') session.lastCheckedAt = source.lastCheckedAt
  if (typeof source.detail === 'string') session.detail = source.detail
  return session
}

function mergeSession(current, patch) {
  if (!isPlainObject(patch)) throw hubError('INVALID_INPUT', 'session 必须是对象')
  const next = normalizeSession(current)
  for (const key of ['status', 'lastLoginAt', 'lastCheckedAt', 'detail']) {
    if (patch[key] === undefined) continue
    if (key === 'status') {
      if (typeof patch.status !== 'string' || !SESSION_STATUSES.has(patch.status)) {
        throw hubError('INVALID_INPUT', `无效的会话状态：${String(patch.status)}`)
      }
      next.status = patch.status
      continue
    }
    if (patch[key] === null) {
      delete next[key]
      continue
    }
    if (typeof patch[key] !== 'string') throw hubError('INVALID_INPUT', `session.${key} 必须是字符串`)
    next[key] = patch[key]
  }
  return next
}

/** Public projection: everything except the password material. */
function toPublic(record) {
  return {
    id: record.id,
    label: record.label,
    url: record.url,
    loginUrl: record.loginUrl,
    searchUrl: record.searchUrl,
    username: record.username,
    loginMode: record.loginMode,
    notes: record.notes,
    visible: record.visible,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    session: { ...record.session },
  }
}

function newAccountId(taken) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = `acc_${randomBytes(6).toString('hex')}`
    if (!taken.has(id)) return id
  }
  throw hubError('INTERNAL', '无法生成账号 id')
}

/**
 * Create the account store rooted at an absolute directory.
 * @param {{dir: string}} options
 */
export async function createStore({ dir } = {}) {
  if (typeof dir !== 'string' || !dir.trim()) throw hubError('INVALID_INPUT', 'createStore 需要 dir 参数')
  const absoluteDir = path.resolve(dir)
  await mkdir(absoluteDir, { recursive: true })

  const dataFile = path.join(absoluteDir, DATA_FILE)
  const keyFile = path.join(absoluteDir, KEY_FILE)
  const secretKey = await loadOrCreateSecretKey(keyFile)

  // ---- password crypto -------------------------------------------------

  function encryptPassword(password) {
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv(ALGO, secretKey, iv)
    const data = Buffer.concat([cipher.update(Buffer.from(password, 'utf8')), cipher.final()])
    const tag = cipher.getAuthTag()
    return {
      algo: ALGO,
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      data: data.toString('base64'),
    }
  }

  function decryptPassword(blob, record) {
    if (!isPlainObject(blob) || blob.algo !== ALGO || typeof blob.iv !== 'string' || typeof blob.tag !== 'string' || typeof blob.data !== 'string') {
      throw hubError('DECRYPT_FAILED', `账号「${record.label}」的密码数据已损坏，请在设置页重新输入密码`)
    }
    try {
      const decipher = createDecipheriv(ALGO, secretKey, Buffer.from(blob.iv, 'base64'))
      decipher.setAuthTag(Buffer.from(blob.tag, 'base64'))
      return Buffer.concat([decipher.update(Buffer.from(blob.data, 'base64')), decipher.final()]).toString('utf8')
    } catch {
      throw hubError('DECRYPT_FAILED', `账号「${record.label}」的密码无法解密（密钥可能已更换），请在设置页重新输入密码`)
    }
  }

  /** Read the current password text without throwing (used for loginMode validation). */
  function tryReadPassword(record) {
    if (!isPlainObject(record.passwordBlob)) return { ok: true, password: '' }
    try {
      return { ok: true, password: decryptPassword(record.passwordBlob, record) }
    } catch {
      return { ok: false }
    }
  }

  // ---- persistence -----------------------------------------------------

  const accounts = await loadAccounts(dataFile, encryptPassword)

  // One queue for every mutation: validates and mutates synchronously, then awaits persist.
  // The queue tail never rejects, so a failed write cannot poison the following operations.
  let queueTail = Promise.resolve()
  function serialize(task) {
    const run = queueTail.then(() => task())
    queueTail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  function serializeRecord(record) {
    return {
      id: record.id,
      label: record.label,
      url: record.url,
      loginUrl: record.loginUrl,
      searchUrl: record.searchUrl,
      username: record.username,
      loginMode: record.loginMode,
      notes: record.notes,
      visible: record.visible,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      session: { ...record.session },
      password: record.passwordBlob,
    }
  }

  async function persist() {
    const payload = { version: FILE_VERSION, accounts: accounts.map(serializeRecord) }
    const text = JSON.stringify(payload, null, 2)
    const tmpFile = `${dataFile}.tmp`
    await writeFile(tmpFile, text, 'utf8')
    try {
      await rename(tmpFile, dataFile)
    } catch (error) {
      // Some Windows setups refuse rename-over-existing while an indexer holds the
      // file; fall back to an in-place write and drop the temp file.
      console.warn(`${LOG_PREFIX} 原子重命名失败，回退为直接写入：${error?.message || error}`)
      await writeFile(dataFile, text, 'utf8')
      try {
        await unlink(tmpFile)
      } catch {
        /* ignore */
      }
    }
    try {
      await chmod(dataFile, 0o600)
    } catch {
      /* Windows may ignore file modes; best effort only */
    }
  }

  // ---- helpers ---------------------------------------------------------

  function findRecord(id) {
    if (typeof id !== 'string' || !id) return undefined
    return accounts.find((record) => record.id === id)
  }

  function findOrThrow(id) {
    const record = findRecord(id)
    if (!record) throw hubError('NOT_FOUND', `账号不存在：${String(id)}`)
    return record
  }

  // ---- public API ------------------------------------------------------

  async function list() {
    return accounts
      .slice()
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1))
      .map(toPublic)
  }

  async function get(id) {
    const record = findRecord(id)
    if (!record) return undefined
    return { ...toPublic(record), password: decryptPassword(record.passwordBlob, record) }
  }

  async function create(input) {
    if (!isPlainObject(input)) throw hubError('INVALID_INPUT', '账号信息必须是对象')
    return serialize(async () => {
      const { url, hostname } = parseRequiredUrl(input.url, '网站地址')
      let label = hostname
      if (input.label !== undefined && input.label !== null) {
        if (typeof input.label !== 'string') throw hubError('INVALID_INPUT', '名称必须是字符串')
        label = input.label.trim() || hostname
      }
      const loginUrl = parseOptionalUrl(input.loginUrl, '登录页地址')
      const searchUrl = parseSearchUrl(input.searchUrl)
      const username = parseRequiredText(input.username, '账号')
      const loginMode = parseLoginMode(input.loginMode, DEFAULT_LOGIN_MODE)
      const password = parsePasswordForCreate(input.password, loginMode)
      const notes = input.notes === undefined || input.notes === null ? '' : String(input.notes)
      const visible = input.visible === true
      const now = nowIso()
      const record = {
        id: newAccountId(new Set(accounts.map((item) => item.id))),
        label,
        url,
        loginUrl,
        searchUrl,
        username,
        loginMode,
        notes,
        visible,
        createdAt: now,
        updatedAt: now,
        session: { status: 'unknown' },
        passwordBlob: encryptPassword(password),
      }
      accounts.push(record)
      await persist()
      return toPublic(record)
    })
  }

  async function update(id, patch) {
    return serialize(async () => {
      const record = findOrThrow(id)
      if (!isPlainObject(patch)) throw hubError('INVALID_INPUT', '修改内容必须是对象')
      // Validate everything first so a rejected patch cannot leave a half-updated record.
      const next = {}
      if (patch.url !== undefined) next.url = parseRequiredUrl(patch.url, '网站地址').url
      if (patch.username !== undefined) next.username = parseRequiredText(patch.username, '账号')
      if (patch.label !== undefined) {
        next.label = patch.label === null || patch.label === '' ? '' : parseRequiredText(patch.label, '名称')
      }
      if (patch.loginUrl !== undefined) next.loginUrl = parseOptionalUrl(patch.loginUrl, '登录页地址')
      if (patch.searchUrl !== undefined) next.searchUrl = parseSearchUrl(patch.searchUrl)
      // loginMode: omitted (undefined/null) means keep the current value; anything else
      // must be exactly 'auto' or 'manual'.
      if (patch.loginMode !== undefined && patch.loginMode !== null) {
        next.loginMode = parseLoginMode(patch.loginMode)
      }
      if (patch.notes !== undefined) next.notes = patch.notes === null ? '' : String(patch.notes)
      if (patch.visible !== undefined) next.visible = patch.visible === true
      // Contract §3: password missing / empty string / null means "keep the current password".
      const password = patch.password === undefined || patch.password === null || patch.password === '' ? null : parsePassword(patch.password)

      // Switching to auto requires a usable password: manual accounts may legitimately
      // have none (Google/passkey sign-ins), but the auto flow has to type one in.
      if (next.loginMode === DEFAULT_LOGIN_MODE) {
        let effective = password
        if (effective === null) {
          const current = tryReadPassword(record)
          if (!current.ok) throw hubError('DECRYPT_FAILED', '当前密码无法解密，切换到自动登录前请重新输入密码')
          effective = current.password
        }
        if (!effective) throw hubError('INVALID_INPUT', '自动登录模式需要非空密码；请填写密码或改为手动登录')
      }

      if (typeof next.label === 'string' && !next.label) next.label = new URL(next.url || record.url).hostname
      Object.assign(record, next)
      if (password !== null) record.passwordBlob = encryptPassword(password)
      record.updatedAt = nowIso()
      await persist()
      return toPublic(record)
    })
  }

  async function remove(id) {
    return serialize(async () => {
      const index = accounts.findIndex((record) => record.id === id)
      if (index === -1) throw hubError('NOT_FOUND', `账号不存在：${String(id)}`)
      accounts.splice(index, 1)
      await persist()
    })
  }

  async function setSession(id, sessionPatch) {
    return serialize(async () => {
      const record = findRecord(id)
      if (!record) return undefined
      record.session = mergeSession(record.session, sessionPatch)
      await persist()
      return toPublic(record)
    })
  }

  return {
    dir: absoluteDir,
    dataFile,
    keyFile,
    list,
    get,
    create,
    update,
    remove,
    setSession,
  }
}

/** Load the 32-byte AES key, generating and persisting one on first use. */
async function loadOrCreateSecretKey(keyFile) {
  try {
    const existing = await readFile(keyFile)
    if (existing.length === KEY_BYTES) return existing
    console.warn(`${LOG_PREFIX} secret.key 长度异常（${existing.length} 字节），将生成新密钥；此前的密码将无法解密`)
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn(`${LOG_PREFIX} 读取 secret.key 失败，将尝试重新生成：${error?.message || error}`)
    }
  }
  const key = randomBytes(KEY_BYTES)
  const tmpFile = `${keyFile}.tmp`
  try {
    await writeFile(tmpFile, key, { mode: 0o600 })
    try {
      await rename(tmpFile, keyFile)
    } catch (error) {
      await writeFile(keyFile, key, { mode: 0o600 })
      try {
        await unlink(tmpFile)
      } catch {
        /* ignore */
      }
    }
  } catch (error) {
    throw hubError('INTERNAL', `无法创建密钥文件：${error?.message || error}`)
  }
  try {
    await chmod(keyFile, 0o600)
  } catch {
    /* best effort */
  }
  return key
}

function recordFromStored(raw, encryptPassword) {
  const url = typeof raw.url === 'string' ? raw.url : ''
  let hostname = ''
  try {
    hostname = new URL(url).hostname
  } catch {
    hostname = url
  }
  const now = nowIso()
  const label = typeof raw.label === 'string' && raw.label ? raw.label : hostname
  // Older data files predate loginMode; treat a missing/invalid value as 'auto'.
  const loginMode =
    typeof raw.loginMode === 'string' && LOGIN_MODES.has(raw.loginMode.trim().toLowerCase())
      ? raw.loginMode.trim().toLowerCase()
      : DEFAULT_LOGIN_MODE
  return {
    id: raw.id,
    label,
    url,
    loginUrl: typeof raw.loginUrl === 'string' ? raw.loginUrl : '',
    searchUrl: typeof raw.searchUrl === 'string' ? raw.searchUrl : '',
    username: typeof raw.username === 'string' ? raw.username : '',
    loginMode,
    notes: typeof raw.notes === 'string' ? raw.notes : '',
    visible: raw.visible === true,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now,
    session: normalizeSession(raw.session),
    passwordBlob: isPlainObject(raw.password)
      ? raw.password
      : // Defensive migration: a hand-edited plaintext password inside the data file is
        // re-encrypted in memory and written out encrypted on the next persist.
        typeof raw.password === 'string' && raw.password
        ? encryptPassword(raw.password)
        : null,
  }
}

/** Read accounts.json, tolerating a missing or corrupt file. */
async function loadAccounts(dataFile, encryptPassword) {
  let text
  try {
    text = await readFile(dataFile, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    console.warn(`${LOG_PREFIX} 读取账号文件失败，按空账号列表启动：${error?.message || error}`)
    return []
  }
  if (!text.trim()) return []
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    console.warn(`${LOG_PREFIX} 账号文件损坏（JSON 解析失败），按空账号列表启动：${error?.message || error}`)
    return []
  }
  const rawAccounts = Array.isArray(parsed) ? parsed : isPlainObject(parsed) && Array.isArray(parsed.accounts) ? parsed.accounts : null
  if (!rawAccounts) {
    console.warn(`${LOG_PREFIX} 账号文件结构异常，按空账号列表启动`)
    return []
  }
  const records = []
  for (const raw of rawAccounts) {
    if (!isPlainObject(raw) || typeof raw.id !== 'string' || !raw.id) {
      console.warn(`${LOG_PREFIX} 跳过一条无效账号记录（缺少 id）`)
      continue
    }
    records.push(recordFromStored(raw, encryptPassword))
  }
  return records
}
