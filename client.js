/**
 * Account Hub — Web client half.
 *
 * Two additive seats:
 *   1. `settings.section` (id `account-hub.settings`, order 70, label 账号管理):
 *      the account manager page — add / edit / delete saved site accounts,
 *      start a visible-browser login and human verification, test the saved
 *      session, and surface the pending verification handoff.
 *   2. `shell.overlay` (id `account-hub.verification`, order 18): a top-center
 *      banner shown only while `state.pending` exists, so the human notices the
 *      visible browser window that was opened for a captcha / 2FA challenge.
 *
 * Accounts carry a `loginMode`: `'auto'` (the Host fills the saved username and
 * password, then hands off captchas) or `'manual'` (the Host only opens the
 * visible login window and never types anything, so Google / Apple / passkey /
 * SMS-code sign-ins work by letting the human finish the step).
 *
 * Data contract (CONTRACT.md §9): same-origin JSON endpoints under
 * `/api/account-hub/*` answering `{ok:true,data}` or `{ok:false,error}`.
 * Both halves poll `/api/account-hub/state` (settings 3s, banner 4s), never
 * overlap requests, and clean up timers / AbortControllers on unmount.
 *
 * Everything here is defensive: slot components that throw blank the whole
 * slot entry, so each registration sits behind an error boundary and every
 * fetch failure is turned into inline text instead of an exception.
 */
window.__ModuleLoader__.load({
  id: 'dsh-account-hub',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const module = { exports: {} }
    const exports = module.exports

    // ---------------------------------------------------------------------
    // Endpoints and timing.
    // ---------------------------------------------------------------------

    const STATE_URL = '/api/account-hub/state'
    const ACCOUNTS_URL = '/api/account-hub/accounts'
    const ACCOUNTS_UPDATE_URL = '/api/account-hub/accounts/update'
    const ACCOUNTS_DELETE_URL = '/api/account-hub/accounts/delete'
    const LOGIN_URL = '/api/account-hub/login'
    const LOGIN_CONFIRM_URL = '/api/account-hub/login/confirm'
    const LOGIN_CANCEL_URL = '/api/account-hub/login/cancel'
    const TEST_URL = '/api/account-hub/test'

    /** Settings page refresh cadence (CONTRACT.md §12). */
    const PAGE_POLL_MS = 3000
    /** Global verification banner refresh cadence (CONTRACT.md §12). */
    const BANNER_POLL_MS = 4000
    /** A state poll never blocks the next tick longer than this. */
    const STATE_TIMEOUT_MS = 10000
    /** Mutating actions may open a browser, so allow a longer bound. */
    const ACTION_TIMEOUT_MS = 60000
    /** Session test may wait for a page load. */
    const TEST_TIMEOUT_MS = 90000

    const FALLBACK_PASSWORD_PLACEHOLDER = '网站登录密码'

    // ---------------------------------------------------------------------
    // Small value helpers.
    // ---------------------------------------------------------------------

    /** Coerce anything to a safe display string. */
    function asText(value) {
      return typeof value === 'string' ? value : ''
    }

    /** Turn any thrown value into a user-facing message. */
    function errorMessage(error) {
      if (error === null || error === undefined) return '未知错误'
      if (typeof error === 'string') return error.length > 0 ? error : '操作失败，请稍后重试'
      if (typeof error.message === 'string' && error.message.length > 0) return error.message
      return '操作失败，请稍后重试'
    }

    /** Basic http(s) URL check; the Host validates again before saving. */
    function isHttpUrl(value) {
      const text = asText(value).trim()
      if (text.length === 0) return false
      try {
        const parsed = new URL(text)
        return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      } catch (error) {
        return false
      }
    }

    /** Host part of a URL, or the raw text when it does not parse. */
    function hostOf(url) {
      if (typeof url !== 'string' || url.length === 0) return ''
      try {
        return new URL(url).host || ''
      } catch (error) {
        return url
      }
    }

    /** Human-readable local timestamp, '—' when absent or invalid. */
    function formatTime(value) {
      if (typeof value !== 'string' || value.length === 0) return '—'
      const time = Date.parse(value)
      if (!Number.isFinite(time)) return '—'
      try {
        return new Date(time).toLocaleString()
      } catch (error) {
        return '—'
      }
    }

    /** Normalize an account login mode; unknown / missing values fall back to 'auto'. */
    function normalizeLoginMode(value) {
      return value === 'manual' ? 'manual' : 'auto'
    }

    // ---------------------------------------------------------------------
    // Data shape normalization (defensive against missing / partial Host data).
    // ---------------------------------------------------------------------

    function normalizeSession(raw) {
      const session = raw !== null && typeof raw === 'object' ? raw : {}
      return {
        status: asText(session.status) || 'unknown',
        lastLoginAt: asText(session.lastLoginAt),
        lastCheckedAt: asText(session.lastCheckedAt),
        detail: asText(session.detail),
      }
    }

    function normalizeAccount(raw) {
      if (raw === null || typeof raw !== 'object') return null
      const id = asText(raw.id)
      if (id.length === 0) return null
      return {
        id,
        label: asText(raw.label),
        url: asText(raw.url),
        loginUrl: asText(raw.loginUrl),
        searchUrl: asText(raw.searchUrl),
        username: asText(raw.username),
        notes: asText(raw.notes),
        visible: raw.visible === true,
        loginMode: normalizeLoginMode(raw.loginMode),
        createdAt: asText(raw.createdAt),
        updatedAt: asText(raw.updatedAt),
        session: normalizeSession(raw.session),
      }
    }

    function normalizePending(raw) {
      if (raw === null || typeof raw !== 'object') return null
      const accountId = asText(raw.accountId)
      if (accountId.length === 0) return null
      return {
        accountId,
        label: asText(raw.label),
        url: asText(raw.url),
        phase: asText(raw.phase) || 'verification-required',
        startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '',
        hint: asText(raw.hint),
        // Optional passthrough: a newer Host may include the mode in pending too.
        loginMode: raw.loginMode === 'manual' ? 'manual' : raw.loginMode === 'auto' ? 'auto' : '',
      }
    }

    /** Normalize the `GET /state` payload; unknown fields are dropped on purpose. */
    function normalizeState(raw) {
      const state = raw !== null && typeof raw === 'object' ? raw : {}
      const rawAccounts = Array.isArray(state.accounts) ? state.accounts : []
      const accounts = []
      for (let index = 0; index < rawAccounts.length; index += 1) {
        const account = normalizeAccount(rawAccounts[index])
        if (account !== null) accounts.push(account)
      }
      let browser = { available: null, executablePath: '', error: '' }
      if (state.browser !== null && typeof state.browser === 'object') {
        browser = {
          available: state.browser.available === true ? true : state.browser.available === false ? false : null,
          executablePath: asText(state.browser.executablePath),
          error: asText(state.browser.error),
        }
      }
      return { accounts, pending: normalizePending(state.pending), browser }
    }

    // ---------------------------------------------------------------------
    // HTTP helpers (envelope contract).
    // ---------------------------------------------------------------------

    /** Read `{ok,data}` / `{ok:false,error}` and throw a usable Error on failure. */
    async function readEnvelope(response) {
      let payload = null
      try {
        payload = await response.json()
      } catch (error) {
        payload = null
      }
      if (payload !== null && typeof payload === 'object' && payload.ok === true) return payload.data
      let code = ''
      let message = ''
      if (payload !== null && typeof payload === 'object' && payload.error !== null && typeof payload.error === 'object') {
        code = asText(payload.error.code)
        message = asText(payload.error.message)
      }
      if (message.length === 0) message = '请求失败（HTTP ' + String(response.status) + '）'
      const failure = new Error(message)
      if (code.length > 0) failure.code = code
      throw failure
    }

    /**
     * One timeout-bounded fetch returning the envelope payload.
     * An outer `signal` (from a polling effect) aborts immediately on cleanup;
     * the internal timeout is reported as a normal user-facing error.
     */
    async function fetchJson(path, options) {
      if (typeof fetch !== 'function') throw new Error('当前页面不支持网络请求，请刷新后重试')
      const opts = options !== null && typeof options === 'object' ? options : {}
      const outerSignal = opts.signal
      const timeoutMs = typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : STATE_TIMEOUT_MS
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      let timer = null
      let onOuterAbort = null
      if (controller !== null) {
        timer = setTimeout(() => {
          try {
            controller.abort()
          } catch (error) {
            // Already aborted; nothing to do.
          }
        }, timeoutMs)
        if (outerSignal !== null && outerSignal !== undefined && typeof outerSignal.addEventListener === 'function') {
          if (outerSignal.aborted === true) {
            try {
              controller.abort()
            } catch (error) {
              // Already aborted.
            }
          } else {
            onOuterAbort = () => {
              try {
                controller.abort()
              } catch (error) {
                // Already aborted.
              }
            }
            outerSignal.addEventListener('abort', onOuterAbort)
          }
        }
      }
      const headers = { accept: 'application/json' }
      const init = {
        method: opts.method === 'POST' ? 'POST' : 'GET',
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
      }
      if (opts.body !== undefined) {
        headers['content-type'] = 'application/json'
        init.body = JSON.stringify(opts.body)
      }
      if (controller !== null) init.signal = controller.signal
      else if (outerSignal !== null && outerSignal !== undefined) init.signal = outerSignal
      try {
        const response = await fetch(path, init)
        return await readEnvelope(response)
      } catch (error) {
        if (error !== null && error !== undefined && error.name === 'AbortError') {
          if (outerSignal !== null && outerSignal !== undefined && outerSignal.aborted === true) throw error
          const timeoutError = new Error('请求超时，请稍后重试')
          timeoutError.name = 'TimeoutError'
          throw timeoutError
        }
        throw error
      } finally {
        if (timer !== null) clearTimeout(timer)
        if (onOuterAbort !== null && outerSignal !== null && outerSignal !== undefined) {
          try {
            outerSignal.removeEventListener('abort', onOuterAbort)
          } catch (error) {
            // Detached signal; nothing to clean.
          }
        }
      }
    }

    function postJson(path, body, timeoutMs) {
      return fetchJson(path, {
        method: 'POST',
        body: body === undefined ? {} : body,
        timeoutMs: typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : ACTION_TIMEOUT_MS,
      })
    }

    /** Fetch + normalize the shared account state snapshot. */
    async function fetchState(signal) {
      const data = await fetchJson(STATE_URL, { method: 'GET', signal, timeoutMs: STATE_TIMEOUT_MS })
      return normalizeState(data)
    }

    // ---------------------------------------------------------------------
    // Polling hook: one request at a time, timer + AbortController cleanup.
    // ---------------------------------------------------------------------

    /**
     * Poll the account state for as long as the calling component is mounted.
     * `reload()` restarts the loop immediately (used after a successful action).
     */
    function useAccountState(intervalMs) {
      const [view, setView] = React.useState({ data: null, error: null, loading: true })
      const [revision, setRevision] = React.useState(0)
      const reload = React.useCallback(() => {
        setRevision((value) => value + 1)
      }, [])
      React.useEffect(() => {
        let disposed = false
        let timer = null
        let controller = null
        const tick = async () => {
          if (disposed) return
          try {
            controller = typeof AbortController === 'function' ? new AbortController() : null
            const data = await fetchState(controller !== null ? controller.signal : undefined)
            if (disposed) return
            setView({ data, error: null, loading: false })
          } catch (error) {
            if (disposed) return
            if (error !== null && error !== undefined && error.name === 'AbortError') return
            setView((previous) => ({ data: previous.data, error: errorMessage(error), loading: false }))
          } finally {
            controller = null
            if (!disposed) {
              timer = setTimeout(() => {
                timer = null
                tick()
              }, intervalMs)
            }
          }
        }
        tick()
        return () => {
          disposed = true
          if (timer !== null) {
            clearTimeout(timer)
            timer = null
          }
          if (controller !== null) {
            try {
              controller.abort()
            } catch (error) {
              // Already settled.
            }
            controller = null
          }
        }
      }, [intervalMs, revision])
      return { data: view.data, error: view.error, loading: view.loading, reload }
    }

    // ---------------------------------------------------------------------
    // Display derivation helpers.
    // ---------------------------------------------------------------------

    /** Status badge tone + Chinese label from the frozen session status set. */
    function statusInfo(account) {
      const session = account !== null && account !== undefined && account.session !== null && typeof account.session === 'object'
        ? account.session
        : {}
      const status = asText(session.status)
      if (status === 'authenticated') return { tone: 'success', label: '已登录' }
      if (status === 'verification-required') return { tone: 'warn', label: '需要真人验证' }
      if (status === 'expired') return { tone: 'error', label: '已过期' }
      if (status === 'error') return { tone: 'error', label: '登录失败' }
      return { tone: 'idle', label: '未登录' }
    }

    function accountTitle(account) {
      if (account === null || account === undefined) return '未命名账号'
      const label = asText(account.label).trim()
      if (label.length > 0) return label
      const host = hostOf(account.url)
      return host.length > 0 ? host : '未命名账号'
    }

    function pendingSite(pending) {
      const label = asText(pending !== null && pending !== undefined ? pending.label : '').trim()
      if (label.length > 0) return label
      const host = hostOf(pending !== null && pending !== undefined ? pending.url : '')
      return host.length > 0 ? host : '已保存账号'
    }

    /** Find one account in a normalized account list. */
    function findAccount(accounts, accountId) {
      if (!Array.isArray(accounts) || typeof accountId !== 'string' || accountId.length === 0) return null
      for (const account of accounts) {
        if (account !== null && account !== undefined && account.id === accountId) return account
      }
      return null
    }

    /** Login mode of the account a pending handoff belongs to. */
    function pendingLoginMode(pending, accounts) {
      if (pending !== null && pending !== undefined) {
        if (pending.loginMode === 'manual') return 'manual'
        if (pending.loginMode === 'auto') return 'auto'
        const account = findAccount(accounts, pending.accountId)
        if (account !== null) return normalizeLoginMode(account.loginMode)
      }
      return 'auto'
    }

    /** Chinese label of one login mode. */
    function loginModeLabel(value) {
      return normalizeLoginMode(value) === 'manual' ? '手动登录' : '自动填表'
    }

    /** Blank add / edit form values. */
    function emptyForm() {
      return {
        label: '',
        url: '',
        loginUrl: '',
        username: '',
        password: '',
        searchUrl: '',
        notes: '',
        visible: false,
        loginMode: 'auto',
      }
    }

    /** Client-side validation mirroring the Host rules; returns a message or ''. */
    function validateForm(form, mode) {
      if (!isHttpUrl(form.url)) return '网站地址必须是完整的 http(s) 地址，例如 https://www.nature.com/'
      if (asText(form.username).trim().length === 0) return '请填写登录账号'
      // Manual mode may legitimately have no site password (Google / passkey
      // sign-up), so only auto mode requires one at creation time.
      if (mode === 'create' && asText(form.password).length === 0 && normalizeLoginMode(form.loginMode) !== 'manual') {
        return '请填写登录密码'
      }
      const loginUrl = asText(form.loginUrl).trim()
      if (loginUrl.length > 0 && !isHttpUrl(loginUrl)) return '登录页地址必须是完整的 http(s) 地址'
      const searchUrl = asText(form.searchUrl).trim()
      if (searchUrl.length > 0 && searchUrl.indexOf('{query}') === -1) return '搜索地址模板必须包含 {query} 占位符'
      return ''
    }

    function buildCreatePayload(form) {
      const payload = {
        url: asText(form.url).trim(),
        username: asText(form.username).trim(),
        // Manual mode may send an empty password: the Host accepts it and never
        // autofills. Auto mode is validated to be non-empty before we get here.
        password: asText(form.password),
        visible: form.visible === true,
        loginMode: normalizeLoginMode(form.loginMode),
      }
      const label = asText(form.label).trim()
      if (label.length > 0) payload.label = label
      const loginUrl = asText(form.loginUrl).trim()
      if (loginUrl.length > 0) payload.loginUrl = loginUrl
      const searchUrl = asText(form.searchUrl).trim()
      if (searchUrl.length > 0) payload.searchUrl = searchUrl
      const notes = asText(form.notes).trim()
      if (notes.length > 0) payload.notes = notes
      return payload
    }

    function buildUpdatePayload(id, form) {
      const payload = {
        id,
        url: asText(form.url).trim(),
        label: asText(form.label).trim(),
        loginUrl: asText(form.loginUrl).trim(),
        searchUrl: asText(form.searchUrl).trim(),
        username: asText(form.username).trim(),
        notes: asText(form.notes).trim(),
        visible: form.visible === true,
        loginMode: normalizeLoginMode(form.loginMode),
      }
      // Empty password means "keep the stored password" (CONTRACT.md §3). This
      // covers manual accounts too: editing never clears a stored password.
      const password = asText(form.password)
      if (password.length > 0) payload.password = password
      return payload
    }

    // ---------------------------------------------------------------------
    // Tiny presentational pieces.
    // ---------------------------------------------------------------------

    /** Colored inline notice; used for page feedback and per-card feedback. */
    function Notice(props) {
      const notice = props !== null && props !== undefined && props.notice !== null && typeof props.notice === 'object'
        ? props.notice
        : null
      if (notice === null) return null
      const text = asText(notice.text)
      if (text.length === 0) return null
      const kind = notice.kind === 'success' ? 'success' : 'error'
      const inline = props.inline === true
      return h('div', {
        className: 'ah_notice ah_notice--' + kind + (inline ? ' ah_notice--inline' : ''),
        role: kind === 'error' ? 'alert' : 'status',
      }, text)
    }

    /** One add / edit form; controlled from the parent so it can be reused. */
    function AccountForm(props) {
      const mode = props !== null && props !== undefined && props.mode === 'edit' ? 'edit' : 'create'
      const value = props !== null && props !== undefined && props.value !== null && typeof props.value === 'object'
        ? props.value
        : emptyForm()
      const busy = props !== null && props !== undefined && props.busy === true
      const onChange = props !== null && props !== undefined && typeof props.onChange === 'function' ? props.onChange : () => {}
      const onSubmit = props !== null && props !== undefined && typeof props.onSubmit === 'function' ? props.onSubmit : () => {}
      const onCancel = props !== null && props !== undefined && typeof props.onCancel === 'function' ? props.onCancel : null
      const loginMode = normalizeLoginMode(value.loginMode)
      const isManual = loginMode === 'manual'
      const passwordPlaceholder = mode === 'edit'
        ? '留空表示不修改密码'
        : isManual
          ? '手动登录不会自动填表，可填写占位内容'
          : FALLBACK_PASSWORD_PLACEHOLDER

      const field = (name, label, options) => {
        const config = options !== null && typeof options === 'object' ? options : {}
        const required = config.required === true
        return h('label', {
          className: 'ah_field' + (config.wide === true ? ' ah_field--wide' : ''),
          key: name,
        },
        h('span', { className: 'ah_label' },
          label,
          required ? h('span', { className: 'ah_req' }, ' *') : null),
        config.multiline === true
          ? h('textarea', {
            className: 'ah_input ah_input--notes',
            value: asText(value[name]),
            placeholder: asText(config.placeholder),
            rows: 3,
            disabled: busy,
            onChange: (event) => onChange(name, event.target.value),
          })
          : h('input', {
            className: 'ah_input',
            type: config.secret === true ? 'password' : 'text',
            value: asText(value[name]),
            placeholder: asText(config.placeholder),
            autoComplete: asText(config.autoComplete) || 'off',
            spellCheck: false,
            disabled: busy,
            onChange: (event) => onChange(name, event.target.value),
          }),
        asText(config.hint).length > 0
          ? h('span', { className: 'ah_fieldHint', key: name + '-hint' }, config.hint)
          : null)
      }

      return h('form', {
        className: 'ah_form',
        onSubmit: (event) => {
          if (event !== null && event !== undefined && typeof event.preventDefault === 'function') event.preventDefault()
          if (!busy) onSubmit()
        },
      },
      field('label', '名称（可选）', { placeholder: '例如：Nature 文献' }),
      field('url', '网站地址', { required: true, placeholder: 'https://www.nature.com/' }),
      field('loginUrl', '登录页地址（可选）', { placeholder: '留空则直接打开网站地址' }),
      field('searchUrl', '搜索地址模板（可选）', { placeholder: 'https://www.nature.com/search?q={query}' }),
      field('username', '账号', { required: true, autoComplete: 'username' }),
      field('password', mode === 'edit' ? '密码（留空表示不修改）' : '密码', {
        required: mode === 'create' && !isManual,
        secret: true,
        autoComplete: mode === 'create' ? 'new-password' : 'off',
        placeholder: passwordPlaceholder,
        hint: isManual
          ? (mode === 'edit'
            ? '手动登录不会自动填表；密码留空表示不修改。'
            : '手动登录不会自动填表；密码可留空（Google 注册账号没有站点密码）。')
          : '',
      }),
      h('label', { className: 'ah_field ah_field--wide', key: 'loginMode' },
        h('span', { className: 'ah_label' }, '登录方式'),
        h('select', {
          className: 'ah_input ah_select',
          value: loginMode,
          disabled: busy,
          onChange: (event) => onChange('loginMode', normalizeLoginMode(event.target.value)),
        },
        h('option', { value: 'auto' }, '自动填写账号密码（默认）'),
        h('option', { value: 'manual' }, '手动登录（Google / Apple / 通行密钥 / 验证码等）')),
        h('span', { className: 'ah_fieldHint' },
          isManual
            ? '插件只打开登录窗口，不会自动填表或提交密码；请你在窗口中使用 Google / Apple / 通行密钥 / 验证码等方式完成登录，完成后点「我已完成验证」。'
            : '插件会在窗口里自动填写上面的账号和密码并提交；遇到验证码时会打开可见窗口等你完成。')),
      field('notes', '备注（可选）', { wide: true, multiline: true, placeholder: '例如：机构订阅账号，仅用于查文献' }),
      h('label', { className: 'ah_check', key: 'visible' },
        h('input', {
          type: 'checkbox',
          checked: value.visible === true,
          disabled: busy,
          onChange: (event) => onChange('visible', event.target.checked === true),
        }),
        h('span', null,
          '搜索时显示浏览器窗口',
          h('span', { className: 'ah_checkHint' }, '（默认后台运行；勾选后每次抓取都会显示窗口）'))),
      h('div', { className: 'ah_formActions', key: 'actions' },
        onCancel !== null
          ? h('button', {
            type: 'button',
            className: 'ah_btn',
            disabled: busy,
            onClick: onCancel,
          }, '取消')
          : null,
        h('button', { type: 'submit', className: 'ah_btn ah_btn--primary', disabled: busy },
          busy ? '处理中…' : mode === 'edit' ? '保存修改' : '添加账号')))
    }

    /** Inline result of the last session test for one account. */
    function TestResult(props) {
      const result = props !== null && props !== undefined && props.result !== null && typeof props.result === 'object'
        ? props.result
        : null
      if (result === null) return null
      const status = asText(result.status) || 'unknown'
      let tone = 'ah_test--warn'
      let title = '测试结果'
      if (status === 'ok') {
        tone = 'ah_test--ok'
        title = '会话可用'
      } else if (status === 'error') {
        tone = 'ah_test--error'
        title = '测试失败'
      } else if (status === 'verification-required') {
        title = '需要真人验证'
      } else if (status === 'login-required') {
        title = '需要先登录'
      }
      const error = result.error !== null && typeof result.error === 'object' ? result.error : null
      const message = asText(result.message) || (error !== null ? asText(error.message) : '')
      return h('div', { className: 'ah_test ' + tone, role: 'status' },
        h('div', { className: 'ah_testHead' }, title),
        asText(result.title) ? h('p', { className: 'ah_testLine' }, '标题：' + result.title) : null,
        asText(result.url) ? h('p', { className: 'ah_testLine ah_mono' }, 'URL：' + result.url) : null,
        asText(result.textSnippet) ? h('p', { className: 'ah_testSnippet' }, result.textSnippet) : null,
        message.length > 0 ? h('p', { className: 'ah_testLine' }, message) : null)
    }

    // ---------------------------------------------------------------------
    // Settings section: the account manager.
    // ---------------------------------------------------------------------

    function AccountManager() {
      const poll = useAccountState(PAGE_POLL_MS)
      const data = poll.data
      const loading = poll.loading
      const pollError = poll.error
      const reload = poll.reload

      const accounts = data !== null && Array.isArray(data.accounts) ? data.accounts : []
      const pending = data !== null ? data.pending : null
      const browser = data !== null ? data.browser : null

      const [addOpen, setAddOpen] = React.useState(false)
      const [addForm, setAddForm] = React.useState(emptyForm)
      const [editingId, setEditingId] = React.useState(null)
      const [editForm, setEditForm] = React.useState(emptyForm)
      const [busy, setBusy] = React.useState(null)
      const [feedback, setFeedback] = React.useState(null)
      const [cardNotices, setCardNotices] = React.useState({})
      const [testResults, setTestResults] = React.useState({})
      const busyRef = React.useRef(false)

      const notifyCard = (cardId, notice) => {
        if (typeof cardId !== 'string' || cardId.length === 0) return
        setCardNotices((previous) => {
          const next = Object.assign({}, previous)
          if (notice === null || notice === undefined) delete next[cardId]
          else next[cardId] = notice
          return next
        })
      }

      /**
       * Run one user action with global single-flight guarding, disabled
       * buttons, and feedback routed either to the page or to one account card.
       */
      const runTask = async (key, work, cardId) => {
        if (busyRef.current) return
        busyRef.current = true
        setBusy(key)
        if (typeof cardId === 'string' && cardId.length > 0) notifyCard(cardId, null)
        else setFeedback(null)
        try {
          const message = await work()
          if (typeof message === 'string' && message.length > 0) {
            const notice = { kind: 'success', text: message }
            if (typeof cardId === 'string' && cardId.length > 0) notifyCard(cardId, notice)
            else setFeedback(notice)
          }
        } catch (error) {
          const notice = { kind: 'error', text: errorMessage(error) }
          if (typeof cardId === 'string' && cardId.length > 0) notifyCard(cardId, notice)
          else setFeedback(notice)
        } finally {
          busyRef.current = false
          setBusy(null)
        }
      }

      const changeAddField = (name, value) => {
        setAddForm((previous) => {
          const next = Object.assign({}, previous)
          next[name] = value
          return next
        })
      }

      const changeEditField = (name, value) => {
        setEditForm((previous) => {
          const next = Object.assign({}, previous)
          next[name] = value
          return next
        })
      }

      const beginEdit = (account) => {
        if (busyRef.current) return
        setEditingId(account.id)
        setEditForm({
          label: account.label,
          url: account.url,
          loginUrl: account.loginUrl,
          username: account.username,
          password: '',
          searchUrl: account.searchUrl,
          notes: account.notes,
          visible: account.visible === true,
          loginMode: normalizeLoginMode(account.loginMode),
        })
        notifyCard(account.id, null)
      }

      const cancelEdit = () => {
        setEditingId(null)
        setEditForm(emptyForm())
      }

      const submitCreate = () => {
        if (busyRef.current) return
        const problem = validateForm(addForm, 'create')
        if (problem.length > 0) {
          setFeedback({ kind: 'error', text: problem })
          return
        }
        runTask('create', async () => {
          await postJson(ACCOUNTS_URL, buildCreatePayload(addForm), ACTION_TIMEOUT_MS)
          setAddForm(emptyForm())
          reload()
          return '账号已添加'
        })
      }

      const saveEdit = (account) => {
        if (busyRef.current) return
        const problem = validateForm(editForm, 'edit')
        if (problem.length > 0) {
          notifyCard(account.id, { kind: 'error', text: problem })
          return
        }
        runTask('save:' + account.id, async () => {
          await postJson(ACCOUNTS_UPDATE_URL, buildUpdatePayload(account.id, editForm), ACTION_TIMEOUT_MS)
          setEditingId(null)
          setEditForm(emptyForm())
          reload()
          return '改动已保存'
        }, account.id)
      }

      const loginAccount = (account) => {
        runTask('login:' + account.id, async () => {
          const result = await postJson(LOGIN_URL, { id: account.id }, ACTION_TIMEOUT_MS)
          const safe = result !== null && typeof result === 'object' ? result : {}
          const status = asText(safe.status)
          reload()
          if (status === 'error') {
            const error = safe.error !== null && typeof safe.error === 'object' ? safe.error : null
            throw new Error(error !== null ? errorMessage(error) : (asText(safe.message) || '无法启动登录流程'))
          }
          if (status === 'busy') throw new Error('该账号已有登录或验证流程正在进行，请先在浏览器窗口中完成。')
          if (asText(safe.message).length > 0) return safe.message
          return normalizeLoginMode(account.loginMode) === 'manual'
            ? '已打开登录窗口：请用 Google / Apple / 通行密钥 / 验证码等方式自行完成登录，完成后点「我已完成验证」。'
            : '已打开浏览器窗口，请完成登录或真人验证。'
        }, account.id)
      }

      const testAccount = (account) => {
        runTask('test:' + account.id, async () => {
          let result = null
          try {
            result = await postJson(TEST_URL, { id: account.id }, TEST_TIMEOUT_MS)
          } catch (error) {
            setTestResults((previous) => {
              const next = Object.assign({}, previous)
              next[account.id] = { status: 'error', message: errorMessage(error) }
              return next
            })
            reload()
            return ''
          }
          setTestResults((previous) => {
            const next = Object.assign({}, previous)
            next[account.id] = result !== null && typeof result === 'object'
              ? result
              : { status: 'error', message: '接口没有返回测试结果' }
            return next
          })
          reload()
          return ''
        }, account.id)
      }

      const deleteAccount = (account) => {
        if (busyRef.current) return
        const title = accountTitle(account)
        let confirmed = false
        try {
          confirmed = typeof window !== 'undefined' && typeof window.confirm === 'function'
            ? window.confirm('确定删除账号「' + title + '」？保存的登录会话也会一并清除。')
            : false
        } catch (error) {
          confirmed = false
        }
        if (!confirmed) return
        runTask('delete:' + account.id, async () => {
          await postJson(ACCOUNTS_DELETE_URL, { id: account.id }, ACTION_TIMEOUT_MS)
          setTestResults((previous) => {
            if (!Object.prototype.hasOwnProperty.call(previous, account.id)) return previous
            const next = Object.assign({}, previous)
            delete next[account.id]
            return next
          })
          if (editingId === account.id) {
            setEditingId(null)
            setEditForm(emptyForm())
          }
          reload()
          setFeedback({ kind: 'success', text: '已删除账号「' + title + '」' })
          return ''
        }, account.id)
      }

      const confirmPending = () => {
        if (pending === null) return
        const accountId = pending.accountId
        runTask('pending:confirm', async () => {
          const result = await postJson(LOGIN_CONFIRM_URL, { id: accountId }, ACTION_TIMEOUT_MS)
          const safe = result !== null && typeof result === 'object' ? result : {}
          const status = asText(safe.status)
          reload()
          if (status === 'still-required') throw new Error('页面仍显示需要验证，请在浏览器窗口完成验证后再点击一次。')
          if (status === 'error') {
            const error = safe.error !== null && typeof safe.error === 'object' ? safe.error : null
            throw new Error(error !== null ? errorMessage(error) : (asText(safe.message) || '确认失败，请稍后重试'))
          }
          return asText(safe.message) || '已确认完成，正在保存登录会话。'
        })
      }

      const cancelPending = () => {
        if (pending === null) return
        const accountId = pending.accountId
        runTask('pending:cancel', async () => {
          await postJson(LOGIN_CANCEL_URL, { id: accountId }, ACTION_TIMEOUT_MS)
          reload()
          return '已取消本次验证。'
        })
      }

      // ----- header / notices -----

      const intro = h('header', { className: 'ah_pageHead' },
        h('h2', { className: 'ah_title' }, '账号管理'),
        h('p', { className: 'ah_intro' },
          '账号仅加密保存在本机；子智能体可通过工具使用已保存的登录会话搜索资料；登录方式可选自动填表或手动登录（Google / 通行密钥等），遇到验证码时会打开可见的浏览器窗口，请你亲手完成。'),
        h('p', { className: 'ah_intro' }, '请自行确认目标网站的服务条款允许自动化访问。'))

      const browserNotice = browser !== null && browser.available === false
        ? h('div', { className: 'ah_notice ah_notice--warn', role: 'status' },
          '未找到可用的浏览器' + (browser.error.length > 0 ? '：' + browser.error : '') +
          '。账号仍可保存，但登录、真人验证与登录会话抓取需要本机安装 Microsoft Edge 或 Google Chrome。')
        : null

      const pollNotice = pollError !== null && pollError !== undefined
        ? h('div', { className: 'ah_notice ah_notice--error', role: 'status' },
          '状态刷新失败：' + errorMessage(pollError) + '（页面会继续自动重试）')
        : null

      const pendingMode = pending === null ? 'auto' : pendingLoginMode(pending, accounts)

      const pendingCard = pending === null
        ? null
        : h('section', { className: 'ah_pending', role: 'status' },
          h('div', { className: 'ah_pendingHead' },
            h('span', { className: 'ah_dot', 'aria-hidden': true }),
            '需要真人验证'),
          h('p', { className: 'ah_pendingText' },
            '站点：' + pendingSite(pending) + '。' +
            (pendingMode === 'manual'
              ? '插件只打开了登录窗口，不会自动填写账号密码；请你在窗口中用 Google / Apple / 通行密钥 / 验证码等方式完成登录，然后点击「我已完成验证」。'
              : '请在弹出的浏览器窗口中完成验证（验证码、短信验证等），完成后点击「我已完成验证」；验证成功后会继续保存登录会话。')),
          pending.hint.length > 0 ? h('p', { className: 'ah_pendingHint' }, pending.hint) : null,
          pending.url.length > 0 ? h('p', { className: 'ah_pendingHint ah_mono' }, pending.url) : null,
          h('div', { className: 'ah_btnRow' },
            h('button', {
              type: 'button',
              className: 'ah_btn ah_btn--primary',
              disabled: busy !== null,
              onClick: confirmPending,
            }, busy === 'pending:confirm' ? '验证中…' : '我已完成验证'),
            h('button', {
              type: 'button',
              className: 'ah_btn',
              disabled: busy !== null,
              onClick: cancelPending,
            }, busy === 'pending:cancel' ? '取消中…' : '取消验证')))

      // ----- add account card -----

      const addCard = h('section', { className: 'ah_card' },
        h('div', { className: 'ah_cardHead' },
          h('div', null,
            h('h3', { className: 'ah_cardTitle' }, '添加账号'),
            h('p', { className: 'ah_cardNote' }, '保存网站地址、账号信息与登录方式后，子智能体即可通过登录会话访问该站点。')),
          h('button', {
            type: 'button',
            className: 'ah_btn' + (addOpen ? '' : ' ah_btn--primary'),
            disabled: busy !== null,
            onClick: () => {
              const next = !addOpen
              setAddOpen(next)
              if (!next) setAddForm(emptyForm())
            },
          }, addOpen ? '收起表单' : '添加账号')),
        addOpen
          ? h(AccountForm, {
            mode: 'create',
            value: addForm,
            busy: busy !== null,
            onChange: changeAddField,
            onSubmit: submitCreate,
            onCancel: () => {
              setAddOpen(false)
              setAddForm(emptyForm())
            },
          })
          : null)

      // ----- one account card -----

      const renderAccountCard = (account) => {
        const info = statusInfo(account)
        const session = account.session
        const isEditing = editingId === account.id
        const cardNotice = Object.prototype.hasOwnProperty.call(cardNotices, account.id) ? cardNotices[account.id] : null
        const testResult = Object.prototype.hasOwnProperty.call(testResults, account.id) ? testResults[account.id] : null
        const host = hostOf(account.url)

        const metaRows = []
        metaRows.push(h('div', { className: 'ah_metaRow', key: 'username' },
          h('span', { className: 'ah_metaKey' }, '账号'),
          h('span', { className: 'ah_metaVal' }, account.username.length > 0 ? account.username : '—')))
        metaRows.push(h('div', { className: 'ah_metaRow', key: 'lastLogin' },
          h('span', { className: 'ah_metaKey' }, '最近登录'),
          h('span', {
            className: 'ah_metaVal',
            title: session.lastCheckedAt.length > 0 ? '最近检查：' + formatTime(session.lastCheckedAt) : undefined,
          }, formatTime(session.lastLoginAt))))
        metaRows.push(h('div', { className: 'ah_metaRow ah_metaRow--wide', key: 'url' },
          h('span', { className: 'ah_metaKey' }, '网站地址'),
          h('span', { className: 'ah_metaVal ah_mono' }, account.url.length > 0 ? account.url : '—')))
        if (session.detail.length > 0) {
          metaRows.push(h('div', { className: 'ah_metaRow ah_metaRow--wide', key: 'detail' },
            h('span', { className: 'ah_metaKey' }, '会话状态'),
            h('span', { className: 'ah_metaVal' }, session.detail)))
        }
        if (account.notes.length > 0) {
          metaRows.push(h('div', { className: 'ah_metaRow ah_metaRow--wide', key: 'notes' },
            h('span', { className: 'ah_metaKey' }, '备注'),
            h('span', { className: 'ah_metaVal' }, account.notes)))
        }

        const actionRow = isEditing ? null : h('div', { className: 'ah_actions' },
          h('button', {
            type: 'button',
            className: 'ah_btn ah_btn--primary',
            disabled: busy !== null,
            onClick: () => loginAccount(account),
          }, busy === 'login:' + account.id
            ? '正在打开…'
            : normalizeLoginMode(account.loginMode) === 'manual' ? '打开登录窗口' : '登录并验证'),
          h('button', {
            type: 'button',
            className: 'ah_btn',
            disabled: busy !== null,
            onClick: () => testAccount(account),
          }, busy === 'test:' + account.id ? '测试中…' : '测试会话'),
          h('button', {
            type: 'button',
            className: 'ah_btn',
            disabled: busy !== null,
            onClick: () => beginEdit(account),
          }, '编辑'),
          h('button', {
            type: 'button',
            className: 'ah_btn ah_btn--danger',
            disabled: busy !== null,
            onClick: () => deleteAccount(account),
          }, busy === 'delete:' + account.id ? '删除中…' : '删除'))

        const editBlock = isEditing
          ? h(AccountForm, {
            mode: 'edit',
            value: editForm,
            busy: busy !== null,
            onChange: changeEditField,
            onSubmit: () => saveEdit(account),
            onCancel: cancelEdit,
          })
          : null

        return h('article', {
          className: 'ah_account' + (isEditing ? ' ah_account--editing' : ''),
          key: account.id,
          'data-account-id': account.id,
        },
        h('div', { className: 'ah_accHead' },
          h('div', { className: 'ah_accTitleWrap' },
            h('span', { className: 'ah_accTitle' }, accountTitle(account)),
            host.length > 0 ? h('span', { className: 'ah_accHost' }, host) : null,
            h('span', {
              className: 'ah_modeTag' + (normalizeLoginMode(account.loginMode) === 'manual' ? ' ah_modeTag--manual' : ''),
              title: normalizeLoginMode(account.loginMode) === 'manual'
                ? '手动登录：插件只打开登录窗口，不自动填表'
                : '自动填表：插件自动填写保存的账号密码',
            }, loginModeLabel(account.loginMode))),
          h('span', {
            className: 'ah_badge ah_badge--' + info.tone,
            title: session.detail.length > 0 ? session.detail : undefined,
          },
          h('span', { className: 'ah_dot', 'aria-hidden': true }),
          info.label)),
        h('div', { className: 'ah_meta' }, metaRows),
        h(Notice, { notice: cardNotice, inline: true }),
        editBlock,
        actionRow,
        h(TestResult, { result: testResult }))
      }

      // ----- account list -----

      const listBody = accounts.length > 0
        ? accounts.map((account) => renderAccountCard(account))
        : h('div', { className: 'ah_placeholder' },
          h('div', { className: 'ah_placeholderTitle' },
            data === null && loading ? '正在加载账号…' : data === null ? '暂时无法读取账号列表' : '还没有保存的账号'),
          data === null
            ? null
            : h('div', { className: 'ah_placeholderText' },
              '点击上方「添加账号」保存网站地址、账号与密码，之后子智能体即可通过工具使用登录会话。'))

      const listSection = h('section', { className: 'ah_listSection' },
        h('div', { className: 'ah_listHead' },
          h('h3', { className: 'ah_listTitle' }, '已保存账号'),
          h('span', { className: 'ah_listCount' }, loading && data === null ? '加载中…' : '共 ' + accounts.length + ' 个')),
        h('div', { className: 'ah_list' }, listBody))

      return h('div', { className: 'ah_page', 'data-plugin': 'dsh-account-hub' },
        h('style', { key: 'ah-styles' }, CSS),
        intro,
        browserNotice,
        pollNotice,
        pendingCard,
        h(Notice, { notice: feedback }),
        addCard,
        listSection)
    }

    // ---------------------------------------------------------------------
    // Global verification banner (shell.overlay, click-through layer).
    // ---------------------------------------------------------------------

    function VerificationBanner() {
      const poll = useAccountState(BANNER_POLL_MS)
      const data = poll.data
      const pending = data !== null ? data.pending : null
      const accounts = data !== null && Array.isArray(data.accounts) ? data.accounts : []
      const pendingMode = pending === null ? 'auto' : pendingLoginMode(pending, accounts)
      const [busy, setBusy] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const busyRef = React.useRef(false)

      const run = async (key, work) => {
        if (busyRef.current) return
        busyRef.current = true
        setBusy(key)
        setNotice(null)
        try {
          const message = await work()
          if (typeof message === 'string' && message.length > 0) setNotice({ kind: 'success', text: message })
        } catch (error) {
          setNotice({ kind: 'error', text: errorMessage(error) })
        } finally {
          busyRef.current = false
          setBusy(null)
        }
      }

      const confirm = () => {
        if (pending === null) return
        const accountId = pending.accountId
        run('confirm', async () => {
          const result = await postJson(LOGIN_CONFIRM_URL, { id: accountId }, ACTION_TIMEOUT_MS)
          const safe = result !== null && typeof result === 'object' ? result : {}
          const status = asText(safe.status)
          poll.reload()
          if (status === 'still-required') throw new Error('页面仍显示需要验证，请完成后再点击一次。')
          if (status === 'error') {
            const error = safe.error !== null && typeof safe.error === 'object' ? safe.error : null
            throw new Error(error !== null ? errorMessage(error) : (asText(safe.message) || '确认失败，请稍后重试'))
          }
          return asText(safe.message) || '已确认，正在保存登录会话。'
        })
      }

      const cancel = () => {
        if (pending === null) return
        const accountId = pending.accountId
        run('cancel', async () => {
          await postJson(LOGIN_CANCEL_URL, { id: accountId }, ACTION_TIMEOUT_MS)
          poll.reload()
          return '已取消本次验证。'
        })
      }

      if (pending === null) return null

      const hintText = pending.hint.length > 0 ? pending.hint : ''
      return h('div', { className: 'ah_verLayer', 'data-plugin': 'dsh-account-hub' },
        h('style', { key: 'ah-styles' }, CSS),
        h('div', { className: 'ah_verCard', role: 'alert' },
          h('div', { className: 'ah_verMain' },
            h('p', { className: 'ah_verText' },
              h('span', { className: 'ah_verTitle' }, pendingMode === 'manual' ? '需要完成登录：' : '需要真人验证：'),
              pendingSite(pending),
              pendingMode === 'manual'
                ? ' — 请在打开的浏览器窗口完成登录（可用 Google / Apple / 通行密钥 / 验证码等方式），完成后自动继续'
                : ' — 请在打开的浏览器窗口完成验证，完成后自动继续'),
            h('div', { className: 'ah_verActions' },
              h('button', {
                type: 'button',
                className: 'ah_btn ah_btn--primary',
                disabled: busy !== null,
                onClick: confirm,
              }, busy === 'confirm' ? '确认中…' : '我已完成验证'),
              h('button', {
                type: 'button',
                className: 'ah_btn',
                disabled: busy !== null,
                onClick: cancel,
              }, busy === 'cancel' ? '取消中…' : '取消验证'))),
          hintText.length > 0 ? h('p', { className: 'ah_verHint' }, hintText) : null,
          notice !== null
            ? h('p', { className: notice.kind === 'error' ? 'ah_verError' : 'ah_verHint' }, notice.text)
            : null))
    }

    // ---------------------------------------------------------------------
    // Error containment: a throwing component would blank its whole slot entry.
    // ---------------------------------------------------------------------

    class AhErrorBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      componentDidCatch(error) {
        try {
          console.warn('[account-hub] UI error contained', error)
        } catch (ignore) {
          // Console may be unavailable; containment still works.
        }
      }

      render() {
        if (this.state.failed) return this.props.fallback === undefined ? null : this.props.fallback
        return h(React.Fragment, null, this.props.children)
      }
    }

    /** Minimal settings-section fallback when the manager tree throws. */
    function SettingsFallback() {
      return h('div', { className: 'ah_page' },
        h('style', { key: 'ah-styles' }, CSS),
        h('div', { className: 'ah_placeholder' },
          h('div', { className: 'ah_placeholderTitle' }, '账号管理暂时无法显示'),
          h('div', { className: 'ah_placeholderText' }, '关闭设置面板后重新打开即可重试；已保存的账号数据不受影响。')))
    }

    function AccountManagerSection(props) {
      return h(AhErrorBoundary, { fallback: h(SettingsFallback, null) }, h(AccountManager, props))
    }

    function VerificationOverlay() {
      return h(AhErrorBoundary, { fallback: null }, h(VerificationBanner, null))
    }

    // ---------------------------------------------------------------------
    // Stylesheet. Rendered as a React <style> element (no global DOM writes);
    // every color comes from the --dsw-alias-* theme tokens so light/dark and
    // the desktop theme follow the host. Class names are all `ah-`-prefixed.
    // ---------------------------------------------------------------------

    const CSS = `
.ah_page{box-sizing:border-box;width:100%;max-width:100%;display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55}
.ah_pageHead{display:flex;flex-direction:column;gap:5px}
.ah_title{margin:0;font-size:16px;line-height:1.4;font-weight:600;color:var(--dsw-alias-label-primary)}
.ah_intro{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.ah_dot{display:inline-block;flex:none;width:6px;height:6px;border-radius:50%;background:currentColor}
.ah_mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.ah_btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:5px;padding:6px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1.4;cursor:pointer;white-space:nowrap}
.ah_btn:hover{background:var(--dsw-alias-bg-layer-2)}
.ah_btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.ah_btn:disabled{opacity:.55;cursor:default}
.ah_btn:disabled:hover{background:transparent}
.ah_btn--primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.ah_btn--primary:hover{background:var(--dsw-alias-bg-layer-2)}
.ah_btn--danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.ah_btn--danger:hover{background:var(--dsw-alias-bg-layer-2)}
.ah_btnRow{display:flex;flex-wrap:wrap;gap:8px}
.ah_notice{box-sizing:border-box;padding:8px 11px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font-size:12px;line-height:1.55;overflow-wrap:anywhere}
.ah_notice--error{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.ah_notice--success{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.ah_notice--warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.ah_notice--inline{margin:0;font-size:11.5px}
.ah_card{box-sizing:border-box;display:flex;flex-direction:column;gap:2px;padding:14px 16px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.ah_cardHead{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.ah_cardTitle{margin:0;font-size:13.5px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}
.ah_cardNote{margin:2px 0 0;font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary)}
.ah_form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 14px;margin-top:12px}
.ah_field{display:flex;flex-direction:column;gap:4px;min-width:0}
.ah_field--wide{grid-column:1 / -1}
.ah_label{font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.ah_req{color:var(--dsw-alias-state-error-primary)}
.ah_input{box-sizing:border-box;width:100%;padding:6px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;line-height:1.45}
.ah_input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.ah_input:disabled{opacity:.6}
.ah_input::placeholder{color:var(--dsw-alias-label-secondary);opacity:.72}
.ah_input--notes{resize:vertical;min-height:56px;font-family:inherit}
.ah_select{appearance:auto;padding-right:6px}
.ah_fieldHint{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);opacity:.9;overflow-wrap:anywhere}
.ah_check{display:flex;align-items:flex-start;gap:7px;grid-column:1 / -1;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary);cursor:pointer}
.ah_check input{flex:none;margin:2px 0 0;accent-color:var(--dsw-alias-brand-primary)}
.ah_checkHint{color:var(--dsw-alias-label-secondary);opacity:.85;margin-left:2px}
.ah_formActions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;grid-column:1 / -1;margin-top:2px}
.ah_listSection{display:flex;flex-direction:column;gap:9px}
.ah_listHead{display:flex;align-items:baseline;justify-content:space-between;gap:10px}
.ah_listTitle{margin:0;font-size:13.5px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}
.ah_listCount{font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.ah_list{display:flex;flex-direction:column;gap:10px}
.ah_account{box-sizing:border-box;display:flex;flex-direction:column;gap:10px;padding:13px 15px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.ah_account--editing{border-color:var(--dsw-alias-brand-primary)}
.ah_accHead{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap}
.ah_accTitleWrap{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;min-width:0}
.ah_accTitle{font-size:13.5px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.ah_accHost{font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow-wrap:anywhere}
.ah_modeTag{display:inline-flex;align-items:center;flex:none;padding:0 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;font-size:10.5px;line-height:1.7;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.ah_modeTag--manual{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.ah_badge{display:inline-flex;align-items:center;gap:5px;flex:none;padding:1px 8px;border:1px solid currentColor;border-radius:999px;font-size:11px;line-height:1.6;white-space:nowrap}
.ah_badge--success{color:var(--dsw-alias-state-success-primary)}
.ah_badge--warn{color:var(--dsw-alias-state-warn-primary)}
.ah_badge--error{color:var(--dsw-alias-state-error-primary)}
.ah_badge--idle{color:var(--dsw-alias-label-secondary)}
.ah_badge--idle .ah_dot{background:var(--dsw-alias-state-idle-primary)}
.ah_meta{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 16px;margin:0}
.ah_metaRow{display:flex;flex-direction:column;gap:1px;min-width:0}
.ah_metaRow--wide{grid-column:1 / -1}
.ah_metaKey{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.ah_metaVal{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.ah_metaVal--mono,.ah_mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.ah_actions{display:flex;flex-wrap:wrap;gap:8px;padding-top:9px;border-top:1px solid var(--dsw-alias-border-l1)}
.ah_pending{box-sizing:border-box;display:flex;flex-direction:column;gap:7px;padding:12px 14px;border:1px solid var(--dsw-alias-state-warn-primary);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.ah_pendingHead{display:flex;align-items:center;gap:7px;font-size:13px;font-weight:600;line-height:1.4;color:var(--dsw-alias-state-warn-primary)}
.ah_pendingText{margin:0;font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.ah_pendingHint{margin:0;font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.ah_test{display:flex;flex-direction:column;gap:4px;padding:9px 11px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:12px;line-height:1.55}
.ah_test--ok{border-color:var(--dsw-alias-state-success-primary)}
.ah_test--warn{border-color:var(--dsw-alias-state-warn-primary)}
.ah_test--error{border-color:var(--dsw-alias-state-error-primary)}
.ah_testHead{font-weight:600;color:var(--dsw-alias-label-primary)}
.ah_testLine{margin:0;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.ah_testSnippet{margin:0;max-height:96px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.ah_placeholder{display:flex;flex-direction:column;align-items:center;gap:5px;padding:22px 16px;text-align:center;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.ah_placeholderTitle{font-size:13px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}
.ah_placeholderText{max-width:420px;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.ah_verLayer{position:fixed;top:14px;left:0;right:0;display:flex;justify-content:center;padding:0 16px;pointer-events:none;z-index:60}
.ah_verCard{pointer-events:auto;box-sizing:border-box;width:100%;max-width:min(720px,100%);display:flex;flex-direction:column;gap:7px;padding:10px 14px;border:1px solid var(--dsw-alias-state-warn-primary);border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12.5px;line-height:1.55}
.ah_verMain{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.ah_verText{margin:0;flex:1 1 280px;min-width:0;overflow-wrap:anywhere}
.ah_verTitle{font-weight:600;color:var(--dsw-alias-state-warn-primary)}
.ah_verActions{display:flex;flex-wrap:wrap;gap:8px;flex:none}
.ah_verHint{margin:0;font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.ah_verError{margin:0;font-size:11.5px;line-height:1.55;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
@media (max-width:640px){
  .ah_form{grid-template-columns:minmax(0,1fr)}
  .ah_meta{grid-template-columns:minmax(0,1fr)}
  .ah_verMain{flex-direction:column}
  .ah_verActions{width:100%;justify-content:flex-end}
}
`

    // ---------------------------------------------------------------------
    // Slot registrations.
    // ---------------------------------------------------------------------

    const inject = ['slots']

    /**
     * Register the Settings page section and the global verification banner.
     * Both registrations are owned by the slot service and disappear on unload.
     */
    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'account-hub.settings',
        order: 70,
        label: '账号管理',
      }, AccountManagerSection))
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'account-hub.verification',
        order: 18,
      }, VerificationOverlay))
    }

    const plugin = { inject, apply }

    exports.default = plugin
    exports.apply = plugin.apply
    exports.inject = plugin.inject
    return module.exports
  },
})
