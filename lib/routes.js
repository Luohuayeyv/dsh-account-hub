/**
 * dsh-account-hub — HTTP routes for the Settings UI.
 *
 * Registers 11 exact routes under /api/account-hub on the Host webServer and answers
 * with a JSON envelope:
 *   success: { ok: true, data: ... }
 *   failure: { ok: false, error: { code, message } }
 *
 * Every response carries `content-type: application/json; charset=utf-8` and
 * `cache-control: no-cache`. Request bodies are JSON, hard-capped at 64 KiB.
 * The webServer service is optional: when it is unavailable the routes are skipped
 * with a warning so the plugin keeps working for agents alone.
 */

import { hubError, toErrorPayload } from './accountService.js'

const BODY_LIMIT_BYTES = 64 * 1024
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-cache',
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

function httpError(code, message, httpStatus) {
  const error = hubError(code, message)
  error.httpStatus = httpStatus
  return error
}

function send(res, statusCode, payload, extraHeaders) {
  if (!res) return
  if (res.headersSent) {
    try {
      res.end()
    } catch {
      /* ignore */
    }
    return
  }
  res.writeHead(statusCode, { ...JSON_HEADERS, ...(extraHeaders || {}) })
  res.end(JSON.stringify(payload))
}

function sendOk(res, data) {
  send(res, 200, { ok: true, data })
}

function sendError(res, statusCode, code, message, extraHeaders) {
  send(res, statusCode, { ok: false, error: { code, message } }, extraHeaders)
}

/** Map an error code onto a useful HTTP status while keeping the JSON envelope. */
function httpStatusForCode(code) {
  switch (code) {
    case 'INVALID_INPUT':
    case 'INVALID_JSON':
    case 'BAD_REQUEST':
      return 400
    case 'PAYLOAD_TOO_LARGE':
      return 413
    case 'NOT_FOUND':
      return 404
    case 'AMBIGUOUS':
    case 'BUSY':
    case 'DECRYPT_FAILED':
      return 409
    case 'NO_BROWSER':
    case 'NOT_READY':
      return 503
    default:
      return 500
  }
}

function readJsonBody(req, limitBytes = BODY_LIMIT_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limitBytes) {
        fail(httpError('PAYLOAD_TOO_LARGE', `请求体超过 ${limitBytes} 字节上限`, 413))
        // Drain instead of pausing: the response is sent immediately, and draining
        // lets the socket finish cleanly for the client.
        try {
          req.resume()
        } catch {
          /* ignore */
        }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) {
        resolve({})
        return
      }
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        reject(httpError('INVALID_JSON', '请求体不是合法 JSON', 400))
        return
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        reject(httpError('INVALID_JSON', '请求体必须是 JSON 对象', 400))
        return
      }
      resolve(parsed)
    })
    req.on('error', (error) => fail(httpError('BAD_REQUEST', `读取请求体失败：${error?.message || error}`, 400)))
  })
}

function requireId(value) {
  if (typeof value !== 'string' || !value.trim()) throw hubError('INVALID_INPUT', '缺少 id')
  return value.trim()
}

function maxCharsOptions(body) {
  if (!body || typeof body !== 'object' || body.maxChars === undefined) return undefined
  return { maxChars: body.maxChars }
}

/**
 * Route table: one webServer registration per path (the webServer rejects duplicate
 * `(kind, path)` pairs), with a per-method handler. Together these cover the 11
 * method+path endpoints from the contract.
 *
 * Handlers receive (service, body) and return the `data` payload.
 * HEAD is served through the GET handler (Node strips the body of a HEAD response).
 */
const ROUTES = [
  {
    path: '/api/account-hub/state',
    handlers: {
      GET: async (service) => {
        const state = await service.state()
        return {
          accounts: state.accounts,
          pending: state.pending ?? null,
          browser: state.browser,
        }
      },
    },
  },
  {
    path: '/api/account-hub/accounts',
    handlers: {
      GET: (service) => service.list(),
      POST: (service, body) => service.create(body),
    },
  },
  {
    path: '/api/account-hub/accounts/update',
    handlers: {
      POST: (service, body) => {
        const { id, ...patch } = body
        return service.update(requireId(id), patch)
      },
    },
  },
  {
    path: '/api/account-hub/accounts/delete',
    handlers: {
      POST: async (service, body) => {
        await service.remove(requireId(body.id))
        return { deleted: true }
      },
    },
  },
  {
    path: '/api/account-hub/login',
    handlers: {
      POST: async (service, body) => {
        const result = await service.login(requireId(body.id))
        const data = { status: result.status, message: result.message || '' }
        if (result.pending !== undefined) data.pending = result.pending
        return data
      },
    },
  },
  {
    path: '/api/account-hub/login/confirm',
    handlers: {
      POST: async (service, body) => {
        const result = await service.confirmLogin(requireId(body.id))
        return { status: result.status, message: result.message || '' }
      },
    },
  },
  {
    path: '/api/account-hub/login/cancel',
    handlers: {
      POST: async (service, body) => {
        const result = await service.cancelLogin(requireId(body.id))
        return { status: result.status }
      },
    },
  },
  {
    path: '/api/account-hub/test',
    handlers: {
      POST: (service, body) => service.test(requireId(body.id)),
    },
  },
  {
    path: '/api/account-hub/fetch',
    handlers: {
      POST: (service, body) => service.fetch(requireId(body.id), body.url, maxCharsOptions(body)),
    },
  },
  {
    path: '/api/account-hub/search',
    handlers: {
      POST: (service, body) => service.search(requireId(body.id), body.query, maxCharsOptions(body)),
    },
  },
]

/** Number of method+path endpoints covered (11 per contract §9). */
const ENDPOINT_COUNT = ROUTES.reduce((total, route) => total + Object.keys(route.handlers).length, 0)

async function handleRoute(route, service, req, res, log) {
  try {
    const method = String(req?.method || 'GET').toUpperCase()
    const handler = route.handlers[method] || (method === 'HEAD' ? route.handlers.GET : undefined)
    if (!handler) {
      sendError(res, 405, 'METHOD_NOT_ALLOWED', `该接口仅支持 ${Object.keys(route.handlers).join(', ')} 请求`, {
        allow: Object.keys(route.handlers).join(', '),
      })
      return
    }
    const body = method === 'POST' ? await readJsonBody(req, BODY_LIMIT_BYTES) : {}
    const data = await handler(service, body)
    sendOk(res, data === undefined ? null : data)
  } catch (error) {
    const payload = toErrorPayload(error)
    const statusCode = Number.isInteger(error?.httpStatus) ? error.httpStatus : httpStatusForCode(payload.code)
    if (statusCode >= 500) log(`路由 ${route.path} 失败：${payload.code} ${payload.message}`)
    sendError(res, statusCode, payload.code, payload.message)
  }
}

/**
 * Register all routes on the Host webServer.
 *
 * @param {object} ctx cordis plugin context
 * @param {object} service accountService instance
 * @param {{log?: (...args:any[])=>void} | ((...args:any[])=>void)} [optionsOrLog]
 * @returns {() => void} idempotent disposer
 */
export function registerRoutes(ctx, service, optionsOrLog = {}) {
  const { log = defaultLog } = normalizeOptions(optionsOrLog)
  const webServer = ctx && typeof ctx.get === 'function' ? ctx.get('webServer') : ctx?.webServer
  if (!webServer || typeof webServer.register !== 'function') {
    console.warn('[account-hub] webServer 不可用，账号管理 HTTP 接口未注册（agent 工具不受影响）')
    return () => {}
  }
  if (!service || typeof service.state !== 'function') {
    console.error('[account-hub] 注册 HTTP 路由失败：accountService 不可用')
    return () => {}
  }

  const disposers = []
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const disposeRoute of disposers.splice(0).reverse()) {
      try {
        disposeRoute()
      } catch (error) {
        console.error('[account-hub] 释放 HTTP 路由失败', error?.message || error)
      }
    }
  }

  try {
    for (const route of ROUTES) {
      const disposeRoute = webServer.register({
        kind: 'exact',
        path: route.path,
        handler: (req, res) => handleRoute(route, service, req, res, log),
      })
      if (typeof disposeRoute === 'function') disposers.push(disposeRoute)
    }
  } catch (error) {
    console.error('[account-hub] 注册 HTTP 路由失败，已回滚', error?.message || error)
    dispose()
    return () => {}
  }

  if (ctx && typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => dispose)
    } catch (error) {
      console.error('[account-hub] 注册路由卸载钩子失败', error?.message || error)
    }
  }
  log(`已注册 ${disposers.length} 条路径（${ENDPOINT_COUNT} 个 method+path 接口，/api/account-hub/*）`)
  return dispose
}

export { ROUTES, ENDPOINT_COUNT }
